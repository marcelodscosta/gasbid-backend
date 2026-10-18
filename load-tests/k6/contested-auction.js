/**
 * Cenário 6 — Leilão disputado: 1 solicitação, N fornecedores dando lance AO MESMO TEMPO.
 * Valida a serialização dos lances (SELECT ... FOR UPDATE) sob concorrência.
 *
 *   k6 run \
 *     -e BASE_URL=https://staging.exemplo.com \
 *     -e BUYER_EMAIL=... -e BUYER_PASSWORD=... \
 *     -e SUPPLIER_ACCOUNTS="forn1@x.com:senha,forn2@x.com:senha,...(50)" \
 *     load-tests/k6/contested-auction.js
 *
 * Esperado:
 *   - ZERO respostas 5xx/409/429 (rejeições de regra de negócio são 400 e são normais);
 *   - todas as propostas aceitas respeitam a diferença mínima no momento do lance;
 *   - p95 do lance < 500 ms mesmo com todos competindo pela mesma linha.
 *
 * ATENÇÃO: o comprador só pode ter 1 cotação aberta; rode com um comprador sem pedido em andamento.
 */
import http from 'k6/http'
import { check } from 'k6'
import { Counter, Rate, Trend } from 'k6/metrics'

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3333'
const BUYER = { email: __ENV.BUYER_EMAIL || 'comprador@saborecia.com.br', password: __ENV.BUYER_PASSWORD || 'buyer123' }
const SUPPLIERS = (__ENV.SUPPLIER_ACCOUNTS || 'vendas@gasmax.com.br:supplier123')
  .split(',')
  .map((p) => {
    const i = p.indexOf(':')
    return { email: p.slice(0, i).trim(), password: p.slice(i + 1).trim() }
  })
const ROUNDS = Number(__ENV.ROUNDS || 3) // cada fornecedor dá ROUNDS lances, todos em paralelo por rodada

const accepted = new Counter('bids_accepted')
const rejectedByRule = new Counter('bids_rejected_by_rule')
const unexpected = new Rate('bids_unexpected_errors')
const bidDuration = new Trend('bid_duration', true)

export const options = {
  scenarios: {
    auction: {
      executor: 'per-vu-iterations',
      vus: SUPPLIERS.length,
      iterations: ROUNDS,
      maxDuration: '3m',
    },
  },
  thresholds: {
    bids_unexpected_errors: ['rate==0'],
    bid_duration: ['p(95)<500'],
  },
}

const json = { 'Content-Type': 'application/json' }

function login(a) {
  const res = http.post(`${BASE_URL}/auth/login`, JSON.stringify(a), { headers: json })
  if (res.status !== 200) throw new Error(`login ${a.email} falhou: ${res.status}`)
  return res.json('token')
}

export function setup() {
  const buyerToken = login(BUYER)
  const h = { headers: { ...json, Authorization: `Bearer ${buyerToken}` } }

  const me = http.get(`${BASE_URL}/me`, h).json()
  const addressId = me.company.addresses[0].id
  const products = http.get(`${BASE_URL}/products`).json()

  const created = http.post(
    `${BASE_URL}/buyer-requests`,
    JSON.stringify({
      addressId,
      items: [{ productId: products[0].id, quantity: 2 }],
      deadline: new Date(Date.now() + 6 * 3600 * 1000).toISOString(),
      paymentMethod: 'PIX',
    }),
    h,
  )
  if (created.status !== 201) throw new Error(`não criou a solicitação (${created.status}): ${created.body}`)
  const request = http.get(`${BASE_URL}/buyer-requests/${created.json('id')}`, h).json()

  // Logins dos fornecedores no setup (evita estourar o limite de login durante a disputa)
  const tokens = SUPPLIERS.map(login)
  return { requestId: request.id, itemIds: request.items.map((i) => i.id), tokens }
}

export default function (data) {
  const token = data.tokens[(__VU - 1) % data.tokens.length]
  // Preços aleatórios e próximos para forçar colisões na regra de R$ 2,00
  const unitPrice = Number((95 + Math.random() * 10).toFixed(2))

  const res = http.post(
    `${BASE_URL}/buyer-requests/${data.requestId}/proposals`,
    JSON.stringify({
      items: data.itemIds.map((id) => ({ buyerRequestItemId: id, unitPrice })),
      freightPrice: 0,
      deliveryDeadline: new Date(Date.now() + 3600 * 1000).toISOString(),
    }),
    { headers: { ...json, Authorization: `Bearer ${token}` }, tags: { name: 'bid' } },
  )
  bidDuration.add(res.timings.duration)

  const ok = res.status === 200 || res.status === 201
  const rule = res.status === 400 // diferença mínima / janela encerrada / prazo
  if (ok) accepted.add(1)
  else if (rule) rejectedByRule.add(1)
  unexpected.add(!ok && !rule)
  check(res, { 'sem erro de servidor/concorrência': (r) => r.status < 500 && r.status !== 409 && r.status !== 429 })
}

export function teardown(data) {
  const token = login(BUYER)
  const res = http.get(`${BASE_URL}/buyer-requests/${data.requestId}/proposals`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  const proposals = res.json() || []
  console.log(`Propostas ativas ao final: ${proposals.length} (uma por fornecedor, sem duplicidade)`)
  const perSupplier = {}
  for (const p of proposals) perSupplier[p.supplierCompanyId] = (perSupplier[p.supplierCompanyId] || 0) + 1
  const dupes = Object.values(perSupplier).filter((n) => n > 1).length
  console.log(`Fornecedores com propostas duplicadas: ${dupes} (esperado: 0)`)
  if (dupes > 0) throw new Error('Duplicidade de propostas por fornecedor: falha de concorrência')
}
