import { BuyerRequestStatus, OrderStatus } from '@prisma/client'

/** Transições permitidas para solicitações de compra. */
export const REQUEST_TRANSITIONS: Record<BuyerRequestStatus, BuyerRequestStatus[]> = {
  DRAFT: ['OPEN', 'CANCELLED'],
  OPEN: ['UNDER_REVIEW', 'AWARDED', 'CANCELLED', 'EXPIRED'],
  UNDER_REVIEW: ['AWARDED', 'CANCELLED', 'EXPIRED', 'OPEN'],
  AWARDED: ['UNDER_REVIEW'], // somente via sistema (fornecedor não confirmou)
  CANCELLED: [],
  EXPIRED: [],
}

/** Transições que o comprador pode disparar manualmente. */
export const BUYER_REQUEST_MANUAL: BuyerRequestStatus[] = ['UNDER_REVIEW', 'CANCELLED']

/** Status em que ainda é possível escolher/aceitar uma proposta. */
export const ACCEPTING_STATUSES: BuyerRequestStatus[] = ['OPEN', 'UNDER_REVIEW']

/** Status de proposta que podem ser aceitos. */
export const ACCEPTABLE_PROPOSAL_STATUSES = ['SUBMITTED', 'UPDATED', 'COUNTER_OFFER'] as const

/** Transições estritas de pedido (sem pular etapas). */
export const ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING_CONFIRMATION: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_DELIVERY', 'CANCELLED'],
  IN_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
}

/** Pedidos considerados "em andamento". */
export const ACTIVE_ORDER_STATUSES: OrderStatus[] = ['PENDING_CONFIRMATION', 'CONFIRMED', 'IN_DELIVERY']

/** Diferença mínima entre lances (R$). */
export const MIN_BID_DECREMENT = 2

/** Tempo para o fornecedor confirmar o pedido (min). */
export const SUPPLIER_CONFIRM_MINUTES = 5

/** Tempo extra dado ao comprador ao reabrir após falha do fornecedor (min). */
export const REVIEW_GRACE_MINUTES = 10

export function canTransition<T extends string>(map: Record<T, T[]>, from: T, to: T) {
  return map[from]?.includes(to) ?? false
}
