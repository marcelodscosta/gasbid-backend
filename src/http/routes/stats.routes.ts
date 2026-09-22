import { FastifyInstance } from 'fastify'
import { authenticate } from '../middlewares/auth'
import { getSupplierStatsUseCase } from '../../use-cases/stats'

export async function statsRoutes(app: FastifyInstance) {
  app.addHook('onRequest', authenticate)

  app.get('/supplier', async (request, reply) => {
    const { month, year } = request.query as { month?: string, year?: string }
    const user = request.user as any
    const companyId = user.companyId

    if (!companyId || user.role !== 'SUPPLIER') {
      return reply.status(403).send({ message: 'Apenas fornecedores podem ver estatísticas de fornecedor.' })
    }

    const d = new Date()
    const m = month || String(d.getMonth() + 1).padStart(2, '0')
    const y = year || String(d.getFullYear())

    const stats = await getSupplierStatsUseCase(companyId, m, y)
    return reply.status(200).send(stats)
  })
}
