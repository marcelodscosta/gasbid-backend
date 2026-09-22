import { FastifyInstance } from 'fastify'
import { authenticate } from '../middlewares/auth'
import { prisma } from '../../lib/prisma'

export async function pushTokenRoutes(app: FastifyInstance) {
  // Registrar push token (chamado pelo app no login/startup)
  app.post('/push-tokens', { preHandler: [authenticate] }, async (req, reply) => {
    const { sub: userId } = req.user as { sub: string }
    const { token, platform } = req.body as { token: string; platform: string }

    if (!token || !platform) {
      return reply.status(400).send({ error: 'Token e platform são obrigatórios' })
    }

    // Upsert: se o token já existe, atualiza o userId e reativa
    const pushToken = await prisma.pushToken.upsert({
      where: { token },
      update: {
        userId,
        platform,
        active: true,
      },
      create: {
        userId,
        token,
        platform,
        active: true,
      },
    })

    return reply.status(201).send(pushToken)
  })

  // Remover push token (chamado pelo app no logout)
  app.delete('/push-tokens/:token', { preHandler: [authenticate] }, async (req, reply) => {
    const { token } = req.params as { token: string }

    await prisma.pushToken.updateMany({
      where: { token },
      data: { active: false },
    })

    return reply.status(204).send()
  })
}
