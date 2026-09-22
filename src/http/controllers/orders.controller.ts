import { FastifyRequest, FastifyReply } from 'fastify'
import {
  listOrdersUseCase,
  getOrderUseCase,
  updateOrderStatusUseCase,
} from '../../use-cases/orders'
import { updateOrderStatusSchema, paginationSchema, createOrderMessageSchema } from '../../schemas/index'
import { OrderStatus } from '@prisma/client'
import { sendMessageUseCase, listMessagesUseCase } from '../../use-cases/order-messages'

type JWTUser = { sub: string; role: string; companyId: string }

export async function listOrdersController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { page, limit } = paginationSchema.parse(req.query)
  return listOrdersUseCase(user.companyId, user.role, page, limit)
}

export async function getOrderController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  return getOrderUseCase(id, user.companyId)
}

export async function updateOrderStatusController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  const { status, notes } = updateOrderStatusSchema.parse(req.body)
  let result;
  try {
    result = await updateOrderStatusUseCase(id, user.companyId, status as OrderStatus, notes, user.role);
  } catch(err) {
    console.error("API ERROR:", err);
    throw err;
  }
  return reply.send(result)
}

export async function listMessagesController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  const messages = await listMessagesUseCase(id, user.sub)
  return reply.send(messages)
}

export async function sendMessageController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  const { content } = createOrderMessageSchema.parse(req.body)
  const message = await sendMessageUseCase(id, user.sub, content)
  return reply.status(201).send(message)
}
