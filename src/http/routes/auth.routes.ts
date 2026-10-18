import { FastifyInstance } from 'fastify'
import {
  registerController,
  loginController,
  refreshController,
  meController,
} from '../controllers/auth.controller'
import { authenticate } from '../middlewares/auth'

export async function authRoutes(app: FastifyInstance) {
  // Limites por IP contra força bruta / abuso de cadastro
  // AUTH_RATE_LIMIT_MAX permite elevar o limite em staging para testes de carga
  const base = Number(process.env.AUTH_RATE_LIMIT_MAX ?? 10)
  const strict = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } })
  app.post('/auth/register', strict(base), registerController)
  app.post('/auth/login', strict(base), loginController)
  app.post('/auth/refresh', strict(base * 6), refreshController)
  app.get('/me', { preHandler: [authenticate] }, meController)
}
