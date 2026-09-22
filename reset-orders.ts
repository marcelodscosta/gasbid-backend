import { prisma } from './src/lib/prisma';

async function main() {
  await prisma.orderTimeline.deleteMany({});
  await prisma.order.deleteMany({});
  await prisma.supplierProposalItem.deleteMany({});
  await prisma.supplierProposal.deleteMany({});
  await prisma.buyerRequestItem.deleteMany({});
  await prisma.buyerRequest.deleteMany({});
  console.log("Todos os pedidos, propostas e solicitações foram deletados com sucesso!");
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
