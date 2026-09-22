import { FastifyRequest, FastifyReply } from 'fastify'
import {
  registerUseCase,
  loginUseCase,
  createRefreshTokenUseCase,
  refreshAccessTokenUseCase,
  getMeUseCase,
} from '../../use-cases/auth'
import { registerSchema, loginSchema, refreshSchema } from '../../schemas/index'

export async function registerController(req: FastifyRequest, reply: FastifyReply) {
  const data = registerSchema.parse(req.body)
  const result = await registerUseCase(data)
  return reply.status(201).send(result)
}

export async function loginController(req: FastifyRequest, reply: FastifyReply) {
  const { email, password } = loginSchema.parse(req.body)
  req.log.info({ email }, 'Login attempt')
  
  const user = await loginUseCase(email, password)

  const token = req.server.jwt.sign(
    { sub: user.id, role: user.role, companyId: user.companyId },
    { expiresIn: process.env.JWT_EXPIRES_IN ?? '15m' },
  )
  const refreshToken = await createRefreshTokenUseCase(user.id)

  return reply.send({ token, refreshToken, user })
}

export async function refreshController(req: FastifyRequest, reply: FastifyReply) {
  const { refreshToken } = refreshSchema.parse(req.body)
  const { user, newRefreshToken } = await refreshAccessTokenUseCase(refreshToken)

  const token = req.server.jwt.sign(
    { sub: user.id, role: user.role, companyId: user.companyId },
    { expiresIn: process.env.JWT_EXPIRES_IN ?? '15m' },
  )

  return reply.send({ token, refreshToken: newRefreshToken })
}

export async function meController(req: FastifyRequest, reply: FastifyReply) {
  const payload = req.user as { sub: string }
  const user = await getMeUseCase(payload.sub)
  return reply.send(user)
}
