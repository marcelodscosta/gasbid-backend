import { prisma } from '../lib/prisma'

// Neighborhoods in Petrolina - PE with spread out coordinates across the city
const PETROLINA_LOCATIONS = [
  { neighborhood: 'Centro', street: 'Avenida Guararapes', number: '500', lat: -9.3980, lng: -40.5030 },
  { neighborhood: 'Areia Branca', street: 'Avenida São Francisco', number: '120', lat: -9.3820, lng: -40.4850 },
  { neighborhood: 'Pedro Raimundo', street: 'Avenida Honorato Viana', number: '1800', lat: -9.3620, lng: -40.5180 },
  { neighborhood: 'Jardim Amazonas', street: 'Rua das Acácias', number: '340', lat: -9.4120, lng: -40.5250 },
  { neighborhood: 'Cohab VI', street: 'Avenida das Nações', number: '890', lat: -9.3780, lng: -40.5400 },
  { neighborhood: 'José e Maria', street: 'Avenida Francisco Amorim', number: '310', lat: -9.3550, lng: -40.4950 },
  { neighborhood: 'Jatobá / Orla', street: 'Avenida Cardoso de Sá', number: '2100', lat: -9.4180, lng: -40.4750 },
  { neighborhood: 'Henrique Leite', street: 'Rua do Horto', number: '150', lat: -9.3700, lng: -40.4680 },
]

async function main() {
  console.log('🔄 1. Zerando todos os pedidos e propostas...')

  await prisma.supplierRating.deleteMany({})
  await prisma.orderTimeline.deleteMany({})
  await prisma.order.deleteMany({})
  await prisma.supplierProposal.deleteMany({})
  await prisma.buyerRequestItem.deleteMany({})
  await prisma.buyerRequest.deleteMany({})

  console.log('✅ Pedidos e propostas zerados com sucesso!')

  console.log('📍 2. Atualizando endereços das empresas para Petrolina - PE...')

  const companies = await prisma.company.findMany({
    include: { addresses: true }
  })

  let locIndex = 0

  for (const company of companies) {
    const loc = PETROLINA_LOCATIONS[locIndex % PETROLINA_LOCATIONS.length]
    locIndex++

    // Update existing address or create new one
    if (company.addresses.length > 0) {
      for (const addr of company.addresses) {
        await prisma.address.update({
          where: { id: addr.id },
          data: {
            street: loc.street,
            number: loc.number,
            neighborhood: loc.neighborhood,
            city: 'Petrolina',
            state: 'PE',
            zipCode: '56300-000',
            latitude: loc.lat,
            longitude: loc.lng,
          }
        })
      }
    } else {
      await prisma.address.create({
        data: {
          companyId: company.id,
          street: loc.street,
          number: loc.number,
          neighborhood: loc.neighborhood,
          city: 'Petrolina',
          state: 'PE',
          zipCode: '56300-000',
          latitude: loc.lat,
          longitude: loc.lng,
          isMain: true,
        }
      })
    }

    // Ensure SupplierCoverage is updated for supplier companies
    if (company.role === 'SUPPLIER') {
      await prisma.supplierCoverage.deleteMany({ where: { supplierCompanyId: company.id } })
      await prisma.supplierCoverage.create({
        data: {
          supplierCompanyId: company.id,
          city: 'Petrolina',
          state: 'PE',
          radiusKm: 50,
        }
      })
    }

    console.log(`📍 Empresa "${company.name}" (${company.role}) transferida para Petrolina/PE - Bairro ${loc.neighborhood}`)
  }

  console.log('✨ Migração para Petrolina/PE concluída!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
