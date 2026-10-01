import { prisma } from '../lib/prisma'
import { wsManager } from '../lib/ws'
import { sendPushToCompany } from './push-notification'

export function startCronJobs() {
  console.log('[CRON] Starting cron jobs...')
  
  // 1. Cancel orders in PENDING_CONFIRMATION after 5 minutes
  setInterval(async () => {
    try {
      const fiveMinsAgo = new Date(Date.now() - 5 * 60 * 1000)
      const expiredOrders = await prisma.order.findMany({
        where: {
          status: 'PENDING_CONFIRMATION',
          createdAt: { lt: fiveMinsAgo }
        }
      })

      for (const order of expiredOrders) {
        await prisma.$transaction([
          prisma.order.update({
            where: { id: order.id },
            data: { status: 'CANCELLED' }
          }),
          prisma.orderTimeline.create({
            data: { orderId: order.id, status: 'CANCELLED', notes: 'Cancelado automaticamente: o fornecedor não confirmou o despacho em 5 minutos.' }
          }),
          prisma.buyerRequest.update({
            where: { id: order.buyerRequestId },
            data: { status: 'OPEN' } // Reopen the request so the buyer can pick another proposal
          }),
          prisma.supplierProposal.update({
            where: { id: order.proposalId },
            data: { status: 'REJECTED' }
          })
        ])
        
        const usersToNotify = await prisma.user.findMany({
          where: { companyId: { in: [order.buyerCompanyId, order.supplierCompanyId] } },
          select: { id: true, companyId: true }
        })

        usersToNotify.forEach(u => {
          wsManager.notifyUser(u.id, 'ORDER_UPDATED', { orderId: order.id, status: 'CANCELLED' })
        })

        sendPushToCompany(
          order.supplierCompanyId,
          'Tempo esgotado! ⏳',
          'Você não confirmou o despacho em 5 minutos e perdeu o pedido.',
          { type: 'ORDER_UPDATED', orderId: order.id, status: 'CANCELLED' }
        )
      }
    } catch (e) {
      console.error('[CRON] Error checking expired orders:', e)
    }
  }, 30000) // check every 30s
}
