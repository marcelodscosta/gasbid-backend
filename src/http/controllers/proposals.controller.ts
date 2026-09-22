import { FastifyRequest, FastifyReply } from 'fastify'
import {
  createProposalUseCase,
  listProposalsUseCase,
  acceptProposalUseCase,
  rejectProposalUseCase,
  counterProposalUseCase,
  listSupplierProposalsUseCase,
} from '../../use-cases/proposals'
import { createProposalSchema } from '../../schemas/index'

type JWTUser = { sub: string; role: string; companyId: string }

export async function createProposalController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  const data = createProposalSchema.parse(req.body)
  const result = await createProposalUseCase({
    ...data,
    buyerRequestId: id,
    supplierCompanyId: user.companyId,
  })
  return reply.status(201).send(result)
}

export async function listProposalsController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  return listProposalsUseCase(id, user.companyId)
}

export async function listSupplierProposalsController(req: FastifyRequest) {
  const user = req.user as JWTUser
  console.log(`[MyProposals] Query: companyId=${user.companyId}`)
  const result = await listSupplierProposalsUseCase(user.companyId)
  console.log(`[MyProposals] Result: ${result.length} items`)
  return result
}

export async function acceptProposalController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  const result = await acceptProposalUseCase(id, user.companyId)
  return reply.send(result)
}

export async function rejectProposalController(req: FastifyRequest) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  return rejectProposalUseCase(id, user.companyId)
}

export async function counterProposalController(req: FastifyRequest) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  const { notes } = req.body as { notes: string }
  return counterProposalUseCase(id, user.companyId, notes)
}
