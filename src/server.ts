import 'dotenv/config'
import { buildApp } from './app'
import { startCronJobs } from './services/cron'

async function start() {
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
