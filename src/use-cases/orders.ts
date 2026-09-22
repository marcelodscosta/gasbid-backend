import { prisma } from '../lib/prisma'
import { NotFoundError, ForbiddenError, AppError } from '../errors/app-error'
import { OrderStatus } from '@prisma/client'
import { wsManager } from '../lib/ws'

export async function listOrdersUseCase(companyId: string, role: string, page: number, limit: number) {
  const where = role === 'BUYER'
    ? { buyerCompanyId: companyId }
    : role === 'SUPPLIER'
    ? { supplierCompanyId: companyId }
    : {}

  const [data, total] = await Promise.all([
    prisma.order.findMany({
      where,
      include: {
        buyerRequest: { include: { items: { include: { product: true } } } },
        buyerCompany: { select: { id: true, name: true } },
        supplierCompany: { select: { id: true, name: true } },
        proposal: { include: { items: true } },
        rating: true,
        _count: { select: { messages: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.order.count({ where }),
  ])

  return { data, total, page, limit, pages: Math.ceil(total / limit) }
}

export async function getOrderUseCase(id: string, companyId: string) {
  const order = await prisma.order.findUnique({
    where: { id },
    include: {
      buyerRequest: { include: { items: { include: { product: true } }, address: true } },
      buyerCompany: { select: { id: true, name: true, cnpj: true } },
      supplierCompany: { select: { id: true, name: true, cnpj: true } },
      proposal: { include: { items: true } },
      timeline: { orderBy: { createdAt: 'asc' } },
      _count: { select: { messages: true } },
    },
  })

  if (!order) throw new NotFoundError('Pedido')
  if (order.buyerCompanyId !== companyId && order.supplierCompanyId !== companyId) {
    throw new ForbiddenError()
  }

  return order
}

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  CREATED: ['CONFIRMED', 'IN_DELIVERY', 'DELIVERED', 'CANCELLED'],
  CONFIRMED: ['IN_DELIVERY', 'DELIVERED', 'CANCELLED'],
  IN_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
}

export async function updateOrderStatusUseCase(
  id: string,
  companyId: string,
  status: OrderStatus,
  notes?: string,
  userRole?: string,
) {
  const order = await prisma.order.findUnique({ where: { id } })
  if (!order) throw new NotFoundError('Pedido')

  const isBuyer = String(order.buyerCompanyId) === String(companyId)
  const isSupplier = String(order.supplierCompanyId) === String(companyId)
  const isAdmin = userRole === 'ADMIN'

  if (!isBuyer && !isSupplier && !isAdmin) {
    throw new ForbiddenError()
  }

  const allowed = VALID_TRANSITIONS[order.status]
  console.log(`[DEBUG] Updating order ${id} from ${order.status} to ${status}. Allowed: ${allowed}`)
  
  if (!allowed.includes(status)) {
    throw new AppError(`Transição de ${order.status} → ${status} não permitida`)
  }

  if (status === 'CANCELLED' && isBuyer && (order.status === 'IN_DELIVERY' || order.status === 'DELIVERED')) {
    throw new AppError('O pedido já saiu para entrega e não pode mais ser cancelado pelo aplicativo')
  }

  if ((status === 'CONFIRMED' || status === 'IN_DELIVERY') && !isSupplier && !isAdmin) {
    throw new AppError('Apenas o fornecedor pode confirmar ou despachar o pedido')
  }
  if (status === 'DELIVERED' && !isBuyer && !isAdmin) {
    throw new AppError('Apenas o comprador pode marcar como entregue')
  }

  const data: Record<string, unknown> = { status }
  if (status === 'CONFIRMED') data.confirmedAt = new Date()
  if (status === 'DELIVERED') data.deliveredAt = new Date()

  const [updated] = await prisma.$transaction([
    prisma.order.update({ where: { id }, data }),
    prisma.orderTimeline.create({ data: { orderId: id, status, notes } }),
  ])

  // WebSocket Notification
  try {
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: { in: [order.buyerCompanyId, order.supplierCompanyId] } },
      select: { id: true }
    })
    
    console.log(`[WS] Notifying ${usersToNotify.length} users about ORDER_UPDATED`)
    usersToNotify.forEach(user => {
      wsManager.notifyUser(user.id, 'ORDER_UPDATED', { orderId: id, status })
    })
  } catch (err) {
    console.error('Error sending WS notification', err)
  }

  return updated
}
