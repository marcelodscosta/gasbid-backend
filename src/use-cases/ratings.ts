import { prisma } from '../lib/prisma'
import { AppError, NotFoundError, ForbiddenError } from '../errors/app-error'
import { sendPushToCompany } from '../services/push-notification'

export async function rateOrderUseCase(
  orderId: string,
  buyerCompanyId: string,
  stars: number,
  comment?: string,
) {
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) {
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

  // Grava a avaliação e recalcula a média pré-computada da empresa na mesma transação,
  // evitando carregar todas as avaliações a cada leitura (ver Company.ratingAvg/ratingCount).
  const result = await prisma.$transaction(async tx => {
    const rating = await tx.supplierRating.upsert({
      where: { orderId },
      create: {
        orderId,
        buyerCompanyId,
        supplierCompanyId: order.supplierCompanyId,
        stars,
        comment,
      },
      update: { stars, comment },
    })

    const agg = await tx.supplierRating.aggregate({
      where: { supplierCompanyId: order.supplierCompanyId },
      _avg: { stars: true },
      _count: { _all: true },
    })
    await tx.company.update({
      where: { id: order.supplierCompanyId },
      data: {
        ratingAvg: agg._avg.stars == null ? null : Number(agg._avg.stars.toFixed(1)),
        ratingCount: agg._count._all,
      },
    })

    return rating
  })

  sendPushToCompany(
    order.supplierCompanyId,
    `Nova avaliação: ${'⭐'.repeat(stars)}`,
    comment ? `"${comment.substring(0, 80)}"` : `Você recebeu ${stars} estrela${stars > 1 ? 's' : ''}!`,
    { type: 'RATING_RECEIVED', orderId },
  )

  return result
}

export async function getSupplierRatingSummary(supplierCompanyId: string) {
  const company = await prisma.company.findUnique({
    where: { id: supplierCompanyId },
    select: { ratingAvg: true, ratingCount: true },
  })

  if (!company || company.ratingCount === 0) {
    return { average: null, count: 0 } // No fake initial balance
  }

  return { average: company.ratingAvg, count: company.ratingCount }
}
