import { FastifyRequest, FastifyReply } from 'fastify'
import {
  createBuyerRequestUseCase,
  listBuyerRequestsUseCase,
  getBuyerRequestUseCase,
  listOpportunitiesUseCase,
  cancelBuyerRequestUseCase,
} from '../../use-cases/buyer-requests'
import { getSupplierMetricsUseCase } from '../../use-cases/supplier-metrics'
import { createBuyerRequestSchema, paginationSchema } from '../../schemas/index'

type JWTUser = { sub: string; role: string; companyId: string }

export async function createBuyerRequestController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const data = createBuyerRequestSchema.parse(req.body)
  const result = await createBuyerRequestUseCase({ ...data, buyerCompanyId: user.companyId })
  return reply.status(201).send(result)
}

export async function listBuyerRequestsController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { page, limit } = paginationSchema.parse(req.query)
  return listBuyerRequestsUseCase(user.companyId, page, limit)
}

export async function getBuyerRequestController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  const companyFilter = user.role === 'BUYER' ? user.companyId : undefined
  const supplierCompanyId = user.role === 'SUPPLIER' ? user.companyId : undefined
  return getBuyerRequestUseCase(id, companyFilter, supplierCompanyId)
}

export async function cancelBuyerRequestController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  const result = await cancelBuyerRequestUseCase(id, user.companyId)
  return reply.status(200).send(result)
}

export async function listOpportunitiesController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { page, limit } = paginationSchema.parse(req.query)
  const { showApplied } = req.query as { showApplied?: string }
  console.log(`[Opportunities] Query: companyId=${user.companyId}, showApplied=${showApplied}`)
  const result = await listOpportunitiesUseCase(user.companyId, page, limit, showApplied === 'true')
  console.log(`[Opportunities] Result: ${result.data.length} items`)
  return result
}

export async function getSupplierMetricsController(req: FastifyRequest) {
  const user = req.user as JWTUser
  return getSupplierMetricsUseCase(user.companyId)
}
