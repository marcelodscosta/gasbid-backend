import 'dotenv/config'
import { execSync } from 'node:child_process'
import { buildApp } from './app'
import { startCronJobs } from './services/cron'

/**
 * Aplica as migrations pendentes antes de subir a API (Render não dá acesso ao terminal).
 * Idempotente: o Prisma só executa o que ainda não foi aplicado.
 * Desative com RUN_MIGRATIONS=false.
 */
function runMigrations() {
  const env = process.env.NODE_ENV
  if (process.env.RUN_MIGRATIONS === 'false' || env === 'development' || env === 'test') return
  console.log('[MIGRATE] prisma migrate deploy…')
  try {
    execSync('npx prisma migrate deploy', { stdio: 'inherit' })
  } catch (err) {
    console.error('[MIGRATE] Falha ao aplicar migrations. Abortando a inicialização.')
    process.exit(1)
  }
}

async function start() {
  runMigrations()
  const app = await buildApp()
  const port = Number(process.env.PORT ?? 3333)

  try {
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`🚀 GasBid API running at http://localhost:${port}`)
    startCronJobs()
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
