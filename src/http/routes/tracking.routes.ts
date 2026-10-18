import { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { authenticate, requireRole } from '../middlewares/auth'
import {
  getOrderTrackingUseCase,
  goOfflineUseCase,
  setTrackingEnabledUseCase,
  updateLocationUseCase,
} from '../../use-cases/tracking'

const locationSchema = z.object({
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  heading: z.number().min(0).max(360).nullish(),
  speed: z.number().min(0).nullish(),
})

export async function trackingRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  const supplierOnly = { preHandler: requireRole('SUPPLIER') }

  app.put('/tracking/settings', supplierOnly, async (req, reply) => {
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body)
    const { companyId } = req.user as { companyId: string }
    return reply.send(await setTrackingEnabledUseCase(companyId, enabled))
  })

  app.post('/tracking/location', supplierOnly, async (req, reply) => {
    const body = locationSchema.parse(req.body)
    const { sub, companyId } = req.user as { sub: string; companyId: string }
    return reply.send(await updateLocationUseCase(sub, companyId, body))
  })

  app.post('/tracking/offline', supplierOnly, async (req, reply) => {
    const { companyId } = req.user as { companyId: string }
    return reply.send(await goOfflineUseCase(companyId))
  })

  app.get('/orders/:id/tracking', async (req, reply) => {
    const { id } = req.params as { id: string }
    const { companyId, role } = req.user as { companyId: string; role: string }
    return reply.send(await getOrderTrackingUseCase(id, companyId, role))
  })
}
