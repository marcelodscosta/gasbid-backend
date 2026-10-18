/**
 * Testes de carga do GasBid (k6).  Rode SEMPRE contra staging, nunca em produção.
 *
 *   k6 run -e SCENARIO=smoke  -e BASE_URL=https://staging.exemplo.com load-tests/k6/gasbid.js
 *   cenários: smoke | load | stress | spike | soak
 *
 * Pré-requisitos no servidor de staging:
 *   - AUTH_RATE_LIMIT_MAX=100000 e RATE_LIMIT_MAX=1000000 (o limite padrão por IP bloquearia o teste,
 *     já que todos os usuários virtuais saem do mesmo IP);
 *   - dados do `npm run db:seed` (ou informe as credenciais por variável de ambiente).
 *
 * Mix: ~70% compradores (polling de cotação/pedidos) e ~30% fornecedores (oportunidades/pedidos).
 * Os intervalos de espera imitam o app SEM WebSocket (pior caso), para medir o teto do backend.
 */
import http from 'k6/http'
import { check, sleep, group } from 'k6'
import { Rate, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3333'
const SCENARIO = __ENV.SCENARIO || 'smoke'

const ACCOUNTS = {
  buyer: { email: __ENV.BUYER_EMAIL || 'comprador@saborecia.com.br', password: __ENV.BUYER_PASSWORD || 'buyer123' },
  supplier: { email: __ENV.SUPPLIER_EMAIL || 'vendas@gasmax.com.br', password: __ENV.SUPPLIER_PASSWORD || 'supplier123' },
}

const businessErrors = new Rate('business_errors') // 5xx / 429 / respostas inesperadas
const buyerPoll = new Trend('buyer_poll_duration', true)
const supplierPoll = new Trend('supplier_poll_duration', true)

const SCENARIOS = {
  // 1. Valida os scripts
  smoke: { executor: 'constant-vus', vus: 5, duration: '1m' },
  // 2. Uso real: sobe até 300 VUs em 10 min
  load: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '3m', target: 300 },
      { duration: '6m', target: 300 },
      { duration: '1m', target: 0 },
    ],
  },
  // 3. Descobre onde quebra (p95 > 1s ou erros > 1%)
  stress: {
    executor: 'ramping-vus',
    startVUs: 0,
    stages: [
      { duration: '2m', target: 300 },
      { duration: '3m', target: 800 },
      { duration: '3m', target: 1400 },
      { duration: '3m', target: 2000 },
      { duration: '2m', target: 2000 },
      { duration: '2m', target: 0 },
    ],
  },
  // 4. Pico do almoço: 50 -> 1000 VUs em 30s
  spike: {
    executor: 'ramping-vus',
    startVUs: 50,
    stages: [
      { duration: '1m', target: 50 },
      { duration: '30s', target: 1000 },
      { duration: '2m', target: 1000 },
      { duration: '30s', target: 50 },
      { duration: '1m', target: 50 },
    ],
  },
  // 5. Vazamento de memória (Map do WS, intervals): observe RAM do Node ao longo das 2h
  soak: { executor: 'constant-vus', vus: 200, duration: '2h' },
}

export const options = {
  scenarios: { [SCENARIO]: SCENARIOS[SCENARIO] },
  thresholds: {
    http_req_duration: ['p(95)<500'],
    http_req_failed: ['rate<0.01'],
    business_errors: ['rate<0.01'],
  },
}

function login({ email, password }) {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify({ email, password }), {
    headers: { 'Content-Type': 'application/json' },
    tags: { name: 'login' },
  })
  if (res.status !== 200) throw new Error(`login falhou (${res.status}): ${res.body}`)
  return res.json('token')
}

// Login uma única vez (setup); VUs só refazem login se o token expirar (401).
export function setup() {
  const health = http.get(`${BASE_URL}/health`)
  if (health.status !== 200) throw new Error(`API indisponível em ${BASE_URL}`)
  return { buyerToken: login(ACCOUNTS.buyer), supplierToken: login(ACCOUNTS.supplier) }
}

let tokens = null
function auth(role, data) {
  if (!tokens) tokens = { buyer: data.buyerToken, supplier: data.supplierToken }
  return { headers: { Authorization: `Bearer ${tokens[role]}` } }
}

function get(url, role, data, name, trend) {
  let res = http.get(`${BASE_URL}${url}`, { ...auth(role, data), tags: { name } })
  if (res.status === 401) {
    tokens[role] = login(ACCOUNTS[role]) // token expirou (soak)
    res = http.get(`${BASE_URL}${url}`, { ...auth(role, data), tags: { name } })
  }
  trend.add(res.timings.duration)
  const ok = check(res, { [`${name} 200`]: (r) => r.status === 200 })
  businessErrors.add(!ok)
  return res
}

export default function (data) {
  if (__VU % 10 < 7) {
    group('comprador', () => {
      get('/me', 'buyer', data, 'me', buyerPoll)
      get('/buyer-requests?limit=10', 'buyer', data, 'buyer-requests', buyerPoll)
      get('/orders?limit=10', 'buyer', data, 'orders', buyerPoll)
      get('/suppliers/nearby', 'buyer', data, 'suppliers-nearby', buyerPoll)
    })
    sleep(4 + Math.random() * 2) // polling de ~5 s do app
  } else {
    group('fornecedor', () => {
      get('/marketplace/opportunities?limit=20', 'supplier', data, 'opportunities', supplierPoll)
      get('/my-proposals', 'supplier', data, 'my-proposals', supplierPoll)
      get('/orders?limit=10', 'supplier', data, 'supplier-orders', supplierPoll)
    })
    sleep(6 + Math.random() * 4)
  }
}
