import { FastifyReply, FastifyRequest } from 'fastify'
import { UnauthorizedError, ForbiddenError } from '../../errors/app-error'

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify()
  } catch {
    throw new UnauthorizedError('Token inválido ou expirado')
  }
}

export function requireRole(...roles: string[]) {
  return async (req: FastifyRequest, _reply: FastifyReply) => {
    const user = req.user as { role: string }
    if (!roles.includes(user.role)) {
      throw new ForbiddenError('Sem permissão para esta ação')
    }
  }
}
