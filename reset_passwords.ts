import { prisma } from './src/lib/prisma'
import { hash } from 'bcryptjs'

async function main() {
  console.log('Resetting demo credentials...')

  const users = [
    { email: 'comprador@saborecia.com.br', password: 'buyer123' },
    { email: 'vendas@gasmax.com.br', password: 'supplier123' },
    { email: 'admin@gasbid.com.br', password: 'admin123' },
  ]

  for (const user of users) {
    const passwordHash = await hash(user.password, 6)
    await prisma.user.update({
      where: { email: user.email },
      data: { passwordHash },
    })
    console.log(`Updated password for ${user.email}`)
  }

  console.log('Done!')
}

main()
