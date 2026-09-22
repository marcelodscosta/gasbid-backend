import { prisma } from '../lib/prisma'
import { AppError, NotFoundError, ForbiddenError } from '../errors/app-error'

export async function rateOrderUseCase(
  orderId: string,
  buyerCompanyId: string,
  stars: number,
  comment?: string,
) {
  if (stars < 1 || stars > 5) {
    throw new AppError('A nota deve ser de 1 a 5 estrelas')
  }

  const order = await prisma.order.findUnique({
    where: { id: orderId },
  })

  if (!order) {
    throw new NotFoundError('Pedido')
  }

  if (order.buyerCompanyId !== buyerCompanyId) {
    throw new ForbiddenError('Apenas o comprador do pedido pode avaliá-lo')
  }

  if (order.status !== 'DELIVERED') {
    throw new AppError('Apenas pedidos concluídos (DELIVERED) podem ser avaliados')
  }

  const existingRating = await prisma.supplierRating.findUnique({
    where: { orderId },
  })

  if (existingRating) {
    return prisma.supplierRating.update({
      where: { orderId },
      data: { stars, comment },
    })
  }

  return prisma.supplierRating.create({
    data: {
      orderId,
      buyerCompanyId,
      supplierCompanyId: order.supplierCompanyId,
      stars,
      comment,
    },
  })
}

export async function getSupplierRatingSummary(supplierCompanyId: string) {
  const ratings = await prisma.supplierRating.findMany({
    where: { supplierCompanyId },
    select: { stars: true },
  })

  if (ratings.length === 0) {
    return { average: null, count: 0 } // No fake initial balance
  }

  const total = ratings.reduce((acc, r) => acc + r.stars, 0)
  const average = Number((total / ratings.length).toFixed(1))

  return { average, count: ratings.length }
}
