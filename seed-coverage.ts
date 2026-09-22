import { prisma } from './src/lib/prisma';

async function main() {
  const suppliers = await prisma.company.findMany({
    where: { role: 'SUPPLIER' }
  });

  for (const supplier of suppliers) {
    // Add coverage for São Paulo, SP
    const existing = await prisma.supplierCoverage.findFirst({
      where: { supplierCompanyId: supplier.id, city: 'São Paulo', state: 'SP' }
    });

    if (!existing) {
      await prisma.supplierCoverage.create({
        data: {
          supplierCompanyId: supplier.id,
          city: 'São Paulo',
          state: 'SP'
        }
      });
      console.log(`Cobertura adicionada para: ${supplier.name}`);
    }
  }
}

main().finally(() => prisma.$disconnect());
