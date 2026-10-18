import { prisma } from '../lib/prisma'
import { wsManager } from '../lib/ws'
import { sendPushToCompany } from './push-notification'
import { expireStaleRequestsUseCase } from '../use-cases/buyer-requests'
import {
  ACCEPTABLE_PROPOSAL_STATUSES,
  REVIEW_GRACE_MINUTES,
  SUPPLIER_CONFIRM_MINUTES,
} from '../lib/state-machine'

const TICK_MS = 30_000

/** Agenda um job sem sobreposição de execuções e sem derrubar o processo em caso de erro. */
function every(name: string, ms: number, fn: () => Promise<unknown>) {
  let running = false
  const timer = setInterval(async () => {
    if (running) return
    running = true
    try {
      await fn()
    } catch (e) {
      console.error(`[CRON] ${name} failed:`, e)
    } finally {
      running = false
    }
  }, ms)
  timer.unref?.()
  return timer
}

/**
 * Cancela pedidos que o fornecedor não confirmou a tempo e devolve a cotação ao comprador.
 *
 * - A cotação vai para UNDER_REVIEW (e não OPEN): a janela de propostas já encerrou, então
 *   reabrir como OPEN a deixaria invisível para fornecedores e sem utilidade. Em análise, o
 *   comprador escolhe a próxima melhor proposta (ainda ACEITÁVEL — ver acceptProposalUseCase).
 * - Se não sobrou nenhuma proposta aceitável, a cotação expira.
 * - Idempotente e seguro com várias instâncias: cada pedido só é processado por quem
 *   conseguir o claim condicional (status ainda PENDING_CONFIRMATION).
 */
export async function cancelUnconfirmedOrders(now = new Date()) {
  const cutoff = new Date(now.getTime() - SUPPLIER_CONFIRM_MINUTES * 60_000)
  const stale = await prisma.order.findMany({
    where: { status: 'PENDING_CONFIRMATION', createdAt: { lt: cutoff } },
    select: { id: true, buyerRequestId: true, proposalId: true, buyerCompanyId: true, supplierCompanyId: true },
    take: 100,
  })

  let cancelled = 0
  for (const order of stale) {
    const result = await prisma.$transaction(async tx => {
      const claimed = await tx.order.updateMany({
        where: { id: order.id, status: 'PENDING_CONFIRMATION' },
        data: { status: 'CANCELLED' },
      })
      if (claimed.count === 0) return null

      await tx.orderTimeline.create({
        data: {
          orderId: order.id,
          status: 'CANCELLED',
          notes: `Cancelado automaticamente: o fornecedor não confirmou o despacho em ${SUPPLIER_CONFIRM_MINUTES} minutos.`,
        },
      })
      await tx.supplierProposal.update({ where: { id: order.proposalId }, data: { status: 'REJECTED' } })

      const alternatives = await tx.supplierProposal.count({
        where: {
          buyerRequestId: order.buyerRequestId,
          id: { not: order.proposalId },
          status: { in: [...ACCEPTABLE_PROPOSAL_STATUSES] },
        },
      })
      await tx.buyerRequest.updateMany({
        where: { id: order.buyerRequestId, status: 'AWARDED' },
        data:
          alternatives > 0
            ? { status: 'UNDER_REVIEW', expiresAt: new Date(now.getTime() + REVIEW_GRACE_MINUTES * 60_000) }
            : { status: 'EXPIRED' },
      })
      return { alternatives }
    })
    if (!result) continue
    cancelled++

    try {
      wsManager.notifyCompanies([order.buyerCompanyId, order.supplierCompanyId], 'ORDER_UPDATED', {
        orderId: order.id,
        status: 'CANCELLED',
      })
      wsManager.notifyCompany(order.buyerCompanyId, 'REQUEST_REOPENED', {
        requestId: order.buyerRequestId,
        alternatives: result.alternatives,
      })
      sendPushToCompany(
        order.supplierCompanyId,
        'Tempo esgotado! ⏳',
        `Você não confirmou o despacho em ${SUPPLIER_CONFIRM_MINUTES} minutos e perdeu o pedido.`,
        { type: 'ORDER_UPDATED', orderId: order.id, status: 'CANCELLED' },
      )
      sendPushToCompany(
        order.buyerCompanyId,
        result.alternatives > 0 ? 'Fornecedor não confirmou' : 'Pedido cancelado',
        result.alternatives > 0
          ? 'O fornecedor não confirmou a tempo. Escolha outra proposta para continuar.'
          : 'O fornecedor não confirmou a tempo e não há outras propostas. Crie uma nova cotação.',
        { type: 'REQUEST_REOPENED', requestId: order.buyerRequestId },
      )
    } catch (e) {
      console.error('[CRON] notify error:', e)
    }
  }
  return cancelled
}

export function startCronJobs() {
  every('cancel-unconfirmed-orders', TICK_MS, () => cancelUnconfirmedOrders())
  every('expire-stale-requests', TICK_MS, () => expireStaleRequestsUseCase())
}
