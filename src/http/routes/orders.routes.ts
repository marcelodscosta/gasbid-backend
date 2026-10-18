import { prisma } from '../../lib/prisma'
import { FastifyInstance } from 'fastify'
import { authenticate } from '../middlewares/auth'
import {
  listOrdersController,
  getOrderController,
  updateOrderStatusController,
  listMessagesController,
  sendMessageController,
} from '../controllers/orders.controller'
import {
  adminMetricsController,
  adminListUsersController,
  adminListRequestsController,
  getSystemSettingsController,
  updateSystemSettingsController,
} from '../controllers/admin.controller'

import { requireRole } from '../middlewares/auth'

export async function orderRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/orders', listOrdersController)
  app.get('/orders/:id', getOrderController)
  app.patch('/orders/:id/status', updateOrderStatusController)
  app.get('/orders/:id/messages', listMessagesController)
  app.post('/orders/:id/messages', sendMessageController)

  // Janela de propostas (leitura para qualquer usuário autenticado; edição é só do admin)
  app.get('/settings/proposal-window', async (_req, reply) => {
    const setting = await prisma.systemSetting.findUnique({ where: { key: 'proposal_window_minutes' } })
    const parsed = setting ? parseInt(setting.value, 10) : NaN
    return reply.send({ proposalWindowMinutes: Number.isFinite(parsed) && parsed > 0 ? parsed : 5 })
  })
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)
  app.addHook('preHandler', requireRole('ADMIN'))

  app.get('/admin/metrics', adminMetricsController)
  app.get('/admin/users', adminListUsersController)
  app.get('/admin/requests', adminListRequestsController)
  app.get('/admin/settings', getSystemSettingsController)
  app.put('/admin/settings', updateSystemSettingsController)
}
