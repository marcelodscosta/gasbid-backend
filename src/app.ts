import Fastify, { FastifyInstance } from 'fastify'
import cors from '@fastify/cors'
import rateLimit from '@fastify/rate-limit'
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
import { trackingRoutes } from './http/routes/tracking.routes'
import { serializeDecimals } from './lib/money'

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({
    // Atrás do proxy do Render: necessário para o rate limit enxergar o IP real do cliente
    trustProxy: true,
    logger: {
      level: process.env.NODE_ENV === 'development' ? 'info' : 'warn',
      transport:
        process.env.NODE_ENV === 'development'
          ? { target: 'pino-pretty', options: { colorize: true } }
          : undefined,
    },
  })

  // Plugins
  // CORS: defina CORS_ORIGINS="https://app.exemplo.com,https://admin.exemplo.com" para restringir.
  // Apps nativos não enviam Origin e continuam liberados.
  const allowedOrigins = (process.env.CORS_ORIGINS ?? '').split(',').map(o => o.trim()).filter(Boolean)
  if (allowedOrigins.length === 0 && process.env.NODE_ENV === 'production') {
    app.log.warn('CORS_ORIGINS não definido: aceitando qualquer origem. Defina a variável para restringir.')
  }
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || allowedOrigins.length === 0) return cb(null, true)
      cb(null, allowedOrigins.includes(origin))
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  })

  // Rate limit global por IP; rotas sensíveis (login/registro) têm limite próprio
  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 600),
    timeWindow: '1 minute',
    allowList: req => req.url === '/health',
  })

  const jwtSecret = process.env.JWT_SECRET
  if (!jwtSecret) {
    throw new Error('JWT_SECRET environment variable is required')
  }

  await app.register(jwt, {
    secret: jwtSecret,
  })

  await app.register(websocket)

  // Colunas monetárias são Decimal no banco; a API continua expondo number
  app.addHook('preSerialization', async (_req, _reply, payload) => serializeDecimals(payload))

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
      const decoded = await app.jwt.verify<{ sub: string; companyId?: string | null }>(token)
      const userId = decoded.sub
      
      // Import wsManager using a dynamic import or top-level import
      const { wsManager, companyRegion } = await import('./lib/ws')
      const region = await companyRegion(decoded.companyId)
      wsManager.addClient(userId, socket, { companyId: decoded.companyId, region })

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
  await app.register(trackingRoutes)

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
        message: (error as Error).message,
      })
    }

    // Prisma unique constraint
    if ((error as any).code === 'P2002') {
      return reply.status(409).send({
        error: 'CONFLICT',
        message: 'Registro duplicado',
      })
    }

    // Erros 4xx do Fastify/plugins (rate limit 429, JSON inválido 400, etc.)
    const status = (error as any).statusCode as number | undefined
    if (status && status >= 400 && status < 500) {
      return reply.status(status).send({
        error: status === 429 ? 'RATE_LIMITED' : 'BAD_REQUEST',
        message: status === 429 ? 'Muitas requisições. Aguarde um instante e tente novamente.' : (error as Error).message,
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
