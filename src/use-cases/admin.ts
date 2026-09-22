import { prisma } from '../lib/prisma'

export async function getAdminMetricsUseCase() {
  const [
    totalUsers,
    totalCompanies,
    totalRequests,
    totalOrders,
    openRequests,
    deliveredOrders,
    recentRequests,
    recentOrders,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.company.count(),
    prisma.buyerRequest.count(),
    prisma.order.count(),
    prisma.buyerRequest.count({ where: { status: 'OPEN' } }),
    prisma.order.count({ where: { status: 'DELIVERED' } }),
    prisma.buyerRequest.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: {
        items: { include: { product: true } },
        buyerCompany: { select: { name: true } },
        _count: { select: { proposals: true } },
      },
    }),
    prisma.order.findMany({
      take: 5,
      orderBy: { createdAt: 'desc' },
      include: {
        buyerCompany: { select: { name: true } },
        supplierCompany: { select: { name: true } },
        buyerRequest: { include: { items: { include: { product: true } } } },
      },
    }),
  ])

  const totalRevenue = await prisma.order.aggregate({
    where: { status: 'DELIVERED' },
    _sum: { totalPrice: true },
  })

  return {
    kpis: {
      totalUsers,
      totalCompanies,
      totalRequests,
      totalOrders,
      openRequests,
      deliveredOrders,
      totalRevenue: totalRevenue._sum.totalPrice ?? 0,
    },
    recentRequests,
    recentOrders,
  }
}

export async function listAllUsersUseCase(page: number, limit: number) {
  const [data, total] = await Promise.all([
    prisma.user.findMany({
      select: {
        id: true, name: true, email: true, role: true, createdAt: true,
        company: { select: { id: true, name: true, cnpj: true, active: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.user.count(),
  ])
  return { data, total, page, limit, pages: Math.ceil(total / limit) }
}
