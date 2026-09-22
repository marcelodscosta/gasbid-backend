import 'dotenv/config'
import { buildApp } from './app'

async function start() {
  const app = await buildApp()
  const port = Number(process.env.PORT ?? 3333)

  try {
    await app.listen({ port, host: '0.0.0.0' })
    console.log(`🚀 GasBid API running at http://localhost:${port}`)
  } catch (err) {
    app.log.error(err)
    process.exit(1)
  }
}

start()
