import { FastifyInstance } from 'fastify'
import {
  registerController,
  loginController,
  refreshController,
  meController,
} from '../controllers/auth.controller'
import { authenticate } from '../middlewares/auth'

export async function authRoutes(app: FastifyInstance) {
  app.post('/auth/register', registerController)
  app.post('/auth/login', loginController)
  app.post('/auth/refresh', refreshController)
  app.get('/me', { preHandler: [authenticate] }, meController)
}
