import { app } from './src/app'
import { prisma } from './src/lib/prisma'

async function run() {
  const maria = await prisma.user.findUnique({ where: { email: 'vendas@gasmax.com.br' } })
  const token = app.jwt.sign({ sub: maria.id, role: maria.role, companyId: maria.companyId })
  
  const order = await prisma.order.findFirst({ where: { supplierCompanyId: maria.companyId } })
  
  const res = await app.inject({
    method: 'PATCH',
    url: `/orders/${order.id}/status`,
    headers: {
      authorization: `Bearer ${token}`
    },
    payload: { status: 'CONFIRMED' }
  })
  
  console.log('STATUS:', res.statusCode)
  console.log('BODY:', res.body)
}
run()
