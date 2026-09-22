import { prisma } from '../lib/prisma'
import { NotFoundError, ForbiddenError } from '../errors/app-error'
import { wsManager } from '../lib/ws'
import { sendPushToCompany } from '../services/push-notification'

export async function sendMessageUseCase(orderIdOrBuyerRequestId: string, senderId: string, content: string) {
  let order = await prisma.order.findUnique({
    where: { id: orderIdOrBuyerRequestId }
  })

  if (!order) {
    order = await prisma.order.findUnique({
      where: { buyerRequestId: orderIdOrBuyerRequestId }
    })
  }

  if (!order) {
    throw new NotFoundError('Pedido')
  }

  // Ensure the sender is part of the buyer or supplier company (or is ADMIN)
  const user = await prisma.user.findUnique({ where: { id: senderId } })
  if (!user || (user.role !== 'ADMIN' && user.companyId !== order.buyerCompanyId && user.companyId !== order.supplierCompanyId)) {
    throw new ForbiddenError()
  }

  const message = await prisma.orderMessage.create({
    data: {
      orderId: order.id,
      senderId,
      content
    },
    include: {
      sender: {
        select: { id: true, name: true, companyId: true, role: true }
      }
    }
  })

  try {
    // Notify users in the opposite company
    const targetCompanyId = user.companyId === order.buyerCompanyId 
      ? order.supplierCompanyId 
      : order.buyerCompanyId

    const usersToNotify = await prisma.user.findMany({
      where: { companyId: targetCompanyId },
      select: { id: true }
    })

    usersToNotify.forEach(u => {
      wsManager.notifyUser(u.id, 'NEW_ORDER_MESSAGE', { 
        orderId: order.id, 
        messageId: message.id,
        senderName: user.name
      })
    })

    // Push para o lado oposto
    const preview = content.length > 50 ? content.substring(0, 50) + '...' : content
    sendPushToCompany(
      targetCompanyId,
      `Nova mensagem de ${user.name} 💬`,
      preview,
      { type: 'NEW_ORDER_MESSAGE', orderId: order.id, messageId: message.id }
    )
  } catch (err) {
    console.error('Error sending WS notification', err)
  }

  return message
}

export async function listMessagesUseCase(orderIdOrBuyerRequestId: string, userId: string) {
  let order = await prisma.order.findUnique({
    where: { id: orderIdOrBuyerRequestId }
  })

  if (!order) {
    order = await prisma.order.findUnique({
      where: { buyerRequestId: orderIdOrBuyerRequestId }
    })
  }

  if (!order) {
    throw new NotFoundError('Pedido')
  }

  const user = await prisma.user.findUnique({ where: { id: userId } })
  if (!user || (user.role !== 'ADMIN' && user.companyId !== order.buyerCompanyId && user.companyId !== order.supplierCompanyId)) {
    throw new ForbiddenError()
  }

  return prisma.orderMessage.findMany({
    where: { orderId: order.id },
    include: {
      sender: {
        select: { id: true, name: true, companyId: true, role: true }
      }
    },
    orderBy: { createdAt: 'asc' }
  })
}
