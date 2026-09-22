import { prisma } from './src/lib/prisma'
import { createBuyerRequestUseCase } from './src/use-cases/buyer-requests'
import { createProposalUseCase, acceptProposalUseCase } from './src/use-cases/proposals'
import { updateOrderStatusUseCase } from './src/use-cases/orders'

async function run() {
  const buyer = await prisma.user.findUnique({ where: { email: 'comprador@saborecia.com.br' } })
  const supplier = await prisma.user.findUnique({ where: { email: 'vendas@gasmax.com.br' } })
  const product = await prisma.product.findFirst()
  const address = await prisma.address.findFirst({ where: { companyId: buyer.companyId } })
  
  console.log('1. Creating Request')
  const req = await createBuyerRequestUseCase({
    buyerCompanyId: buyer.companyId,
    productId: product.id,
    addressId: address.id,
    quantity: 10,
    deadline: new Date(Date.now() + 86400000).toISOString(),
    expiresAt: new Date(Date.now() + 3600000).toISOString()
  })
  
  console.log('2. Creating Proposal')
  const prop = await createProposalUseCase({
    buyerRequestId: req.id,
    supplierCompanyId: supplier.companyId,
    unitPrice: 100,
    freightPrice: 20,
    deliveryDays: 1
  })
  
  console.log('3. Accepting Proposal')
  const order = await acceptProposalUseCase(prop.id, buyer.companyId)
  
  console.log('4. Confirming Order as Supplier')
  try {
    const res = await updateOrderStatusUseCase(order.id, supplier.companyId, 'CONFIRMED')
    console.log('SUCCESS:', res.status)
  } catch(e) {
    console.error('FAILED TO CONFIRM:', e)
  }
}
run()
