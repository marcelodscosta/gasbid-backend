import { FastifyRequest, FastifyReply } from 'fastify'
import { getAdminMetricsUseCase, listAllUsersUseCase } from '../../use-cases/admin'
import { paginationSchema } from '../../schemas/index'
import { prisma } from '../../lib/prisma'

export async function adminMetricsController(_req: FastifyRequest, reply: FastifyReply) {
  const metrics = await getAdminMetricsUseCase()
  return reply.send(metrics)
}

export async function adminListUsersController(req: FastifyRequest, reply: FastifyReply) {
  const { page, limit } = paginationSchema.parse(req.query)
  return listAllUsersUseCase(page, limit)
}

export async function adminListRequestsController(req: FastifyRequest, reply: FastifyReply) {
  const { page, limit } = paginationSchema.parse(req.query)
  const [data, total] = await Promise.all([
    prisma.buyerRequest.findMany({
      include: {
        items: { include: { product: true } },
        buyerCompany: { select: { id: true, name: true } },
        _count: { select: { proposals: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.buyerRequest.count(),
  ])
  return { data, total, page, limit, pages: Math.ceil(total / limit) }
}

export async function getSystemSettingsController(_req: FastifyRequest, reply: FastifyReply) {
  const setting = await prisma.systemSetting.findUnique({ where: { key: 'proposal_window_minutes' } })
  return reply.send({ proposalWindowMinutes: setting ? parseInt(setting.value, 10) : 5 })
}

export async function updateSystemSettingsController(req: FastifyRequest, reply: FastifyReply) {
  const { proposalWindowMinutes } = req.body as { proposalWindowMinutes: number }
  const value = Math.max(1, Math.min(120, proposalWindowMinutes || 5)).toString()

  const setting = await prisma.systemSetting.upsert({
    where: { key: 'proposal_window_minutes' },
    update: { value },
    create: { key: 'proposal_window_minutes', value }
  })

  return reply.send({ proposalWindowMinutes: parseInt(setting.value, 10) })
}
