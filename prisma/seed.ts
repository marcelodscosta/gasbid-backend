import { prisma } from '../src/lib/prisma'
import bcrypt from 'bcryptjs'

async function main() {
  console.log('🌱 Seeding database...')

  // Products
  const p13 = await prisma.product.upsert({
    where: { sku: 'GLP-P13' },
    update: {},
    create: {
      name: 'GLP P13 (13kg)',
      sku: 'GLP-P13',
      description: 'Botijão de gás GLP 13kg, uso residencial e comercial',
      unit: 'unidade',
      weightKg: 13,
    },
  })

  const p20 = await prisma.product.upsert({
    where: { sku: 'GLP-P20' },
    update: {},
    create: {
      name: 'GLP P20 (20kg)',
      sku: 'GLP-P20',
      description: 'Botijão de gás GLP 20kg, uso comercial',
      unit: 'unidade',
      weightKg: 20,
    },
  })

  const p45 = await prisma.product.upsert({
    where: { sku: 'GLP-P45' },
    update: {},
    create: {
      name: 'GLP P45 (45kg)',
      sku: 'GLP-P45',
      description: 'Cilindro de gás GLP 45kg, uso industrial',
      unit: 'unidade',
      weightKg: 45,
    },
  })

  console.log('✅ Products created:', p13.sku, p20.sku, p45.sku)

  // Admin company
  const adminCompany = await prisma.company.upsert({
    where: { cnpj: '00000000000000' },
    update: {},
    create: {
      name: 'GasBid Plataforma',
      cnpj: '00000000000000',
      email: 'admin@gasbid.com.br',
      role: 'ADMIN',
    },
  })

  // Admin user
  const adminHash = await bcrypt.hash('admin123', 10)
  await prisma.user.upsert({
    where: { email: 'admin@gasbid.com.br' },
    update: {},
    create: {
      name: 'Admin GasBid',
      email: 'admin@gasbid.com.br',
      passwordHash: adminHash,
      role: 'ADMIN',
      companyId: adminCompany.id,
    },
  })

  // Buyer company
  const buyerCompany = await prisma.company.upsert({
    where: { cnpj: '12345678000195' },
    update: {},
    create: {
      name: 'Restaurante Sabor & Cia',
      cnpj: '12345678000195',
      email: 'contato@saborecia.com.br',
      phone: '11999990001',
      role: 'BUYER',
    },
  })

  const buyerAddress = await prisma.address.create({
    data: {
      companyId: buyerCompany.id,
      street: 'Rua das Flores',
      number: '100',
      neighborhood: 'Centro',
      city: 'São Paulo',
      state: 'SP',
      zipCode: '01310100',
      isMain: true,
      latitude: -23.5505,
      longitude: -46.6333,
    },
  })

  const buyerHash = await bcrypt.hash('buyer123', 10)
  await prisma.user.upsert({
    where: { email: 'comprador@saborecia.com.br' },
    update: {},
    create: {
      name: 'João Comprador',
      email: 'comprador@saborecia.com.br',
      passwordHash: buyerHash,
      role: 'BUYER',
      companyId: buyerCompany.id,
    },
  })

  // Supplier company
  const supplierCompany = await prisma.company.upsert({
    where: { cnpj: '98765432000177' },
    update: {},
    create: {
      name: 'GasMax Distribuidora',
      cnpj: '98765432000177',
      email: 'contato@gasmax.com.br',
      phone: '11999990002',
      role: 'SUPPLIER',
    },
  })

  await prisma.supplierCoverage.upsert({
    where: { id: 'coverage-sp-01' },
    update: {},
    create: {
      id: 'coverage-sp-01',
      supplierCompanyId: supplierCompany.id,
      city: 'São Paulo',
      state: 'SP',
      radiusKm: 50,
    },
  })

  const supplierHash = await bcrypt.hash('supplier123', 10)
  const supplierUser = await prisma.user.upsert({
    where: { email: 'vendas@gasmax.com.br' },
    update: {},
    create: {
      name: 'Maria Fornecedora',
      email: 'vendas@gasmax.com.br',
      passwordHash: supplierHash,
      role: 'SUPPLIER',
      companyId: supplierCompany.id,
    },
  })

  // Add address for supplier
  await prisma.address.create({
    data: {
      companyId: supplierCompany.id,
      street: 'Av. Paulista',
      number: '1000',
      neighborhood: 'Bela Vista',
      city: 'São Paulo',
      state: 'SP',
      zipCode: '01310100',
      isMain: true,
      latitude: -23.5617,
      longitude: -46.6560,
    },
  })

  // Sample BuyerRequest with multiple items
  const request = await prisma.buyerRequest.create({
    data: {
      buyerCompanyId: buyerCompany.id,
      addressId: buyerAddress.id,
      deadline: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      observations: 'Entrega no horário comercial. Pedido de teste multi-item.',
      status: 'OPEN',
      items: {
        create: [
          { productId: p13.id, quantity: 10 },
          { productId: p20.id, quantity: 5 },
        ]
      }
    },
  })

  console.log('✅ Sample buyer request created:', request.id)
  console.log('')
  console.log('🔑 Demo credentials:')
  console.log('  Admin:    admin@gasbid.com.br / admin123')
  console.log('  Buyer:    comprador@saborecia.com.br / buyer123')
  console.log('  Supplier: vendas@gasmax.com.br / supplier123')
  console.log('')
  console.log('✅ Seed completed!')
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
