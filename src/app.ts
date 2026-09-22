import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import jwt from '@fastify/jwt'
import websocket from '@fastify/websocket'
import { ZodError } from 'zod'
import { AppError } from './errors/app-error'
import { authRoutes } from './http/routes/auth.routes'
import { buyerRequestRoutes } from './http/routes/business.routes'
import { orderRoutes, adminRoutes } from './http/routes/orders.routes'
import { supplierProductRoutes } from './http/routes/supplier-products.routes'
import { statsRoutes } from './http/routes/stats.routes'
import { pushTokenRoutes } from './http/routes/push-token.routes'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  })

  // Plugins
  await app.register(cors, {
    origin: (origin, cb) => {
      // Liberando CORS para MVP
      cb(null, true)
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required')
  }

  await app.register(jwt, {
    secret: jwtSecret,
  })

  await app.register(websocket)

  // Health check
  app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }))

  // WebSocket endpoint (prepared for real-time)
  app.get('/ws', { websocket: true }, async (socket, req) => {
    const { token } = req.query as { token?: string }
    if (!token) {
      socket.close(1008, 'Token required')
      return
    }

    try {
      const decoded = await app.jwt.verify<{ sub: string }>(token)
      const userId = decoded.sub
      
      // Import wsManager using a dynamic import or top-level import
      const { wsManager } = await import('./lib/ws')
      wsManager.addClient(userId, socket)

      socket.on('message', () => {
        // Just a ping/pong or basic logging for now
      })
    } catch (err) {
      socket.close(1008, 'Invalid token')
    }
  })

  // Routes
  await app.register(authRoutes)
  await app.register(buyerRequestRoutes)
  await app.register(orderRoutes)
  await app.register(adminRoutes)
  await app.register(supplierProductRoutes)
  await app.register(statsRoutes, { prefix: '/stats' })
  await app.register(pushTokenRoutes)

  // Error handler
  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.status(422).send({
        error: 'VALIDATION_ERROR',
        message: 'Dados inválidos',
        details: error.flatten().fieldErrors,
      })
    }

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: error.code,
        message: error.message,
      })
    }

    // Prisma unique constraint
    if ((error as any).code === 'P2002') {
      return reply.status(409).send({
        error: 'CONFLICT',
        message: 'Registro duplicado',
      })
    }

    req.log.error(error)
    return reply.status(500).send({
      error: 'INTERNAL_ERROR',
      message: 'Erro interno do servidor',
    })
  })

  return app
}
