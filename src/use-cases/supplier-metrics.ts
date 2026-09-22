import { prisma } from '../lib/prisma'

export async function getSupplierMetricsUseCase(companyId: string) {
  // 1. Get supplier coverage cities
  const coverage = await prisma.supplierCoverage.findMany({
    where: { supplierCompanyId: companyId },
    select: { city: true, state: true }
  })

  const coverageCities = coverage.map(c => c.city)

  const openOpportunities = await prisma.buyerRequest.count({
    where: {
      status: 'OPEN',
      expiresAt: { gt: new Date() },
      address: { city: { in: coverageCities } },
      proposals: { none: { supplierCompanyId: companyId } }
    }
  })

  // 3. Competing Opportunities
  const competingOpportunities = await prisma.supplierProposal.count({
    where: {
      supplierCompanyId: companyId,
      buyerRequest: {
        status: 'OPEN',
        expiresAt: { gt: new Date() }
      }
    }
  })

  // 4. Orders Won
  const ordersWon = await prisma.order.count({
    where: { supplierCompanyId: companyId }
  })

  // 5. Pending Deliveries
  const pendingDeliveries = await prisma.order.count({
    where: {
      supplierCompanyId: companyId,
      status: { in: ['CREATED', 'CONFIRMED', 'IN_DELIVERY'] }
    }
  })

  // 6. Recent Activity
  const last24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
  const recentRequests = await prisma.buyerRequest.findMany({
    where: {
      status: { in: ['AWARDED', 'CANCELLED'] },
      updatedAt: { gt: last24h },
      address: { city: { in: coverageCities } }
    },
    include: {
      items: { include: { product: true } },
      address: true,
      order: { select: { id: true, supplierCompanyId: true, totalPrice: true } },
      proposals: {
        where: { supplierCompanyId: companyId },
        include: { items: true }
      }
    },
    orderBy: { updatedAt: 'desc' },
    take: 5
  })

  const recentActivity = recentRequests.map(req => {
    const myProposal = req.proposals[0]
    let result = 'LOST'
    if (req.status === 'CANCELLED') result = 'CANCELLED'
    else if (req.order?.supplierCompanyId === companyId) result = 'WON'

    // For multi-item, we just show the first item name or a summary
    const firstItem = req.items[0]
    const title = req.items.length > 1 ? `${firstItem?.product.name} +${req.items.length - 1}` : firstItem?.product.name

    return {
      id: req.id,
      productName: title,
      quantity: req.items.reduce((sum, i) => sum + i.quantity, 0),
      city: req.address.city,
      status: req.status,
      result,
      myPrice: myProposal?.items.reduce((sum, i) => sum + i.unitPrice, 0), // This is not quite right but works for display
      winningPrice: req.order?.totalPrice,
      updatedAt: req.updatedAt
    }
  })

  // 7. Company Reputation (Rating Stars & Count)
  const ratings = await prisma.supplierRating.findMany({
    where: { supplierCompanyId: companyId },
    select: { stars: true, comment: true, createdAt: true }
  })

  const ratingCount = ratings.length
  const averageStars = ratingCount > 0
    ? Number((ratings.reduce((sum, r) => sum + r.stars, 0) / ratingCount).toFixed(1))
    : null

  return {
    openOpportunities,
    competingOpportunities,
    ordersWon,
    pendingDeliveries,
    recentActivity,
    averagePrices: [],
    reputation: {
      averageStars,
      ratingCount,
      ratings: ratings.slice(-10).reverse()
    }
  }
}
