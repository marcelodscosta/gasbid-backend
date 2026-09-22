import { prisma } from './src/lib/prisma';

async function main() {
  // 1. Find the latest active request
  const activeRequest = await prisma.buyerRequest.findFirst({
    where: { status: 'OPEN' },
    orderBy: { createdAt: 'desc' },
    include: { items: true }
  });

  if (!activeRequest) {
    console.log('Nenhuma solicitação aberta encontrada. Crie uma no app primeiro.');
    return;
  }

  // 2. Get the suppliers we just created
  const suppliers = await prisma.company.findMany({
    where: {
      cnpj: {
        in: ['11111111000111', '22222222000122', '33333333000133', '44444444000144', '55555555000155']
      }
    }
  });

  for (const supplier of suppliers) {
    // Check if proposal already exists
    const existing = await prisma.supplierProposal.findFirst({
      where: { buyerRequestId: activeRequest.id, supplierCompanyId: supplier.id }
    });

    if (existing) {
      console.log(`Proposta de ${supplier.name} já existe.`);
      continue;
    }

    // 3. Create a proposal
    const totalItemsPrice = activeRequest.items.reduce((acc, item) => acc + (item.quantity * (100 + Math.random() * 20)), 0);
    const freightPrice = 10 + Math.random() * 15;

    await prisma.supplierProposal.create({
      data: {
        buyerRequestId: activeRequest.id,
        supplierCompanyId: supplier.id,
        status: 'SENT',
        totalPrice: totalItemsPrice + freightPrice,
        freightPrice,
        items: {
          create: activeRequest.items.map(item => ({
            buyerRequestItemId: item.id,
            unitPrice: 100 + Math.random() * 20,
          }))
        }
      }
    });
    console.log(`Proposta enviada por: ${supplier.name}`);
  }
}

main().finally(() => prisma.$disconnect());
