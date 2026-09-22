import { FastifyInstance } from 'fastify'
import { prisma } from '../../lib/prisma'
import { authenticate } from '../middlewares/auth'
import {
  createBuyerRequestController,
  listBuyerRequestsController,
  getBuyerRequestController,
  cancelBuyerRequestController,
  listOpportunitiesController,
  getSupplierMetricsController,
} from '../controllers/buyer-requests.controller'
import {
  createProposalController,
  listProposalsController,
  acceptProposalController,
  rejectProposalController,
  counterProposalController,
  listSupplierProposalsController,
} from '../controllers/proposals.controller'
import {
  listMessagesController,
  sendMessageController,
} from '../controllers/orders.controller'

export async function buyerRequestRoutes(app: FastifyInstance) {
  // Public Marketplace & Suppliers (Accessible for map display & product browsing)
  app.get('/suppliers/nearby', async () => {
    return prisma.company.findMany({
      where: { role: 'SUPPLIER', active: true },
      include: { 
        addresses: true,
        ratingsReceived: { select: { stars: true } }
      }
    })
  })

  // Products
  app.get('/products', async () => {
    return prisma.product.findMany({ where: { active: true }, orderBy: { weightKg: 'asc' } })
  })

  // Protected routes require authentication
  app.addHook('preHandler', authenticate)

  // Companies / Addresses
  app.post('/companies/:companyId/addresses', async (req, reply) => {
    const { createAddressSchema } = await import('../../schemas/index.js')
    const { companyId } = req.params as { companyId: string }
    const data = createAddressSchema.parse(req.body)
    const address = await prisma.address.create({ data: { ...data, companyId } })
    return reply.status(201).send(address)
  })

  app.get('/companies/:companyId/addresses', async (req) => {
    const { companyId } = req.params as { companyId: string }
    return prisma.address.findMany({ where: { companyId }, orderBy: { isMain: 'desc' } })
  })

  // Buyer Requests
  app.post('/buyer-requests', createBuyerRequestController)
  app.get('/buyer-requests', listBuyerRequestsController)
  app.get('/buyer-requests/:id', getBuyerRequestController)
  app.post('/buyer-requests/:id/cancel', cancelBuyerRequestController)

  // Proposals actions
  app.get('/my-proposals', listSupplierProposalsController)
  app.post('/buyer-requests/:id/proposals', createProposalController)
  app.get('/buyer-requests/:id/proposals', listProposalsController)
  app.post('/proposals/:id/accept', acceptProposalController)
  app.post('/proposals/:id/reject', rejectProposalController)
  app.post('/proposals/:id/counter', counterProposalController)

  // Ratings
  app.post('/orders/:id/rate', async (req, reply) => {
    const { rateOrderUseCase } = await import('../../use-cases/ratings.js')
    const user = req.user as { sub: string; role: string; companyId: string }
    const { id } = req.params as { id: string }
    const { stars, comment } = req.body as { stars: number; comment?: string }

    const rating = await rateOrderUseCase(id, user.companyId, stars, comment)
    return reply.status(201).send(rating)
  })

  // Marketplace
  app.get('/marketplace/opportunities', listOpportunitiesController)
  app.get('/marketplace/metrics', getSupplierMetricsController)
}
