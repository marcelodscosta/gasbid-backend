import { Prisma } from '@prisma/client'

type Numeric = number | string | Prisma.Decimal | null | undefined

/** Converte Decimal/strings do Prisma em number (para cálculos e JSON). */
export function toNum(v: Numeric): number {
  if (v == null) return 0
  if (typeof v === 'number') return v
  return Number(v.toString())
}

/** Arredonda para centavos evitando erros de ponto flutuante. */
export function round2(v: number): number {
  return Math.round((v + Number.EPSILON) * 100) / 100
}

interface PricedItem {
  unitPrice: Numeric
  buyerRequestItem?: { quantity: number } | null
  quantity?: number
}

/** Total de uma proposta = Σ(preço × quantidade) + frete. */
export function proposalTotal(items: PricedItem[], freightPrice: Numeric): number {
  const itemsSum = items.reduce((sum, it) => {
    const qty = it.buyerRequestItem?.quantity ?? it.quantity ?? 1
    return sum + toNum(it.unitPrice) * qty
  }, 0)
  return round2(itemsSum + toNum(freightPrice))
}

/** Converte recursivamente Decimals em number para serialização da API. */
export function serializeDecimals<T>(value: T): T {
  if (value == null || typeof value !== 'object') return value
  if (Prisma.Decimal.isDecimal(value)) return toNum(value as any) as any
  if (value instanceof Date) return value
  if (Array.isArray(value)) return value.map(serializeDecimals) as any
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = serializeDecimals(v)
  }
  return out as T
}
