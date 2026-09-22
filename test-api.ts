import { prisma } from './src/lib/prisma'
import { updateOrderStatusUseCase } from './src/use-cases/orders'

async function run() {
  const order = await prisma.order.findFirst({ include: { supplierCompany: true } })
  if (!order) return console.log('No order')
  
  try {
    const res = await updateOrderStatusUseCase(order.id, order.supplierCompanyId, 'CONFIRMED')
    console.log('SUCCESS:', res)
  } catch (e) {
    console.error('ERROR:', e)
  }
}
run()
