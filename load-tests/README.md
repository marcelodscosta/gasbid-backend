# Testes de carga (k6)

Plano da seção 6 da *Análise GasBid: fluxos, escalabilidade e testes*.

> **Rode somente contra staging.** Os scripts criam cotações e propostas de verdade.

## Preparação do servidor de staging

| Variável | Valor para o teste | Por quê |
|----------|-------------------|---------|
| `RATE_LIMIT_MAX` | `1000000` | O limite global é por IP e todos os VUs saem do mesmo IP |
| `AUTH_RATE_LIMIT_MAX` | `100000` | Idem para `/auth/login` (padrão: 10/min) |
| `DB_POOL_MAX` | `20`–`30` | Tamanho do pool do `pg` (padrão 20) |

## Cenários

```bash
# 1. Smoke (5 VUs, 1 min) — valida os scripts
k6 run -e SCENARIO=smoke  -e BASE_URL=https://staging.exemplo.com load-tests/k6/gasbid.js
# 2. Load (até 300 VUs, 10 min)
k6 run -e SCENARIO=load   ...
# 3. Stress (até 2.000 VUs) — procura o ponto de quebra
k6 run -e SCENARIO=stress ...
# 4. Spike (50 -> 1.000 VUs em 30 s)
k6 run -e SCENARIO=spike  ...
# 5. Soak (200 VUs por 2 h) — vazamento de memória
k6 run -e SCENARIO=soak   ...
# 6. Leilão disputado (N fornecedores no mesmo lance)
k6 run -e SUPPLIER_ACCOUNTS="a@x.com:senha,b@x.com:senha" load-tests/k6/contested-auction.js
```

Credenciais padrão = as do seed (`comprador@saborecia.com.br`, `vendas@gasmax.com.br`).
Troque com `BUYER_EMAIL`, `BUYER_PASSWORD`, `SUPPLIER_EMAIL`, `SUPPLIER_PASSWORD`.

## Thresholds

- `http_req_duration p(95) < 500ms`
- `http_req_failed < 1%`
- `business_errors < 1%` (5xx, 429 e respostas inesperadas)
- Leilão disputado: `bids_unexpected_errors == 0` e `bid_duration p(95) < 500ms`

## O que observar durante a execução

- CPU/RAM do Node e *event loop lag*
- Conexões do Postgres: `SELECT state, count(*) FROM pg_stat_activity GROUP BY 1;`
- Queries lentas: `pg_stat_statements` (ordenar por `mean_exec_time`)
- No soak: crescimento de memória ao longo das 2 h (Map do WebSocket, intervals)

## Limitações conhecidas dos scripts

- Os compradores só leem (cotação/pedidos). Criar solicitações em massa exige uma conta de comprador por VU,
  já que cada comprador só pode ter 1 cotação aberta.
- O mix imita o app **sem** WebSocket (pior caso). Para medir o ganho do tempo real,
  compare com a carga real do app após o deploy da versão com WebSocket.
