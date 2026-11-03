import { prisma } from '../src/lib/prisma'
import bcrypt from 'bcryptjs'

// Seed idempotente: pode rodar várias vezes sem duplicar dados.
// Senha padrão de todos os usuários de demo (sobrescreva com SEED_PASSWORD).
const PASSWORD = process.env.SEED_PASSWORD ?? 'gasbid123'
const CITY = 'Petrolina'
const STATE = 'PE'

type Seller = {
  name: string
  cnpj: string
  email: string
  phone: string
  contact: string
  street: string
  number: string
  neighborhood: string
  zipCode: string
  lat: number
  lng: number
}

const SUPPLIERS: Seller[] = [
  { name: 'Gás Centro Petrolina', cnpj: '11111111000101', email: 'revenda1@gasbid.com.br', phone: '87999990101', contact: 'Carlos Lima', street: 'Rua da Aurora', number: '120', neighborhood: 'Centro', zipCode: '56302000', lat: -9.3891, lng: -40.5030 },
  { name: 'Areia Branca Gás', cnpj: '22222222000102', email: 'revenda2@gasbid.com.br', phone: '87999990102', contact: 'Ana Souza', street: 'Av. das Nações', number: '850', neighborhood: 'Areia Branca', zipCode: '56330000', lat: -9.3812, lng: -40.4925 },
  { name: 'Gás Jardim Maravilha', cnpj: '33333333000103', email: 'revenda3@gasbid.com.br', phone: '87999990103', contact: 'Pedro Alves', street: 'Rua Sete', number: '45', neighborhood: 'Jardim Maravilha', zipCode: '56310000', lat: -9.4075, lng: -40.5160 },
  { name: 'Cohab Gás Distribuidora', cnpj: '44444444000104', email: 'revenda4@gasbid.com.br', phone: '87999990104', contact: 'Juliana Rocha', street: 'Av. Cohab Massangano', number: '300', neighborhood: 'Cohab Massangano', zipCode: '56312000', lat: -9.4002, lng: -40.5305 },
  { name: 'Gás Gercino Coelho', cnpj: '55555555000105', email: 'revenda5@gasbid.com.br', phone: '87999990105', contact: 'Marcos Silva', street: 'Rua Pernambuco', number: '210', neighborhood: 'Gercino Coelho', zipCode: '56306000', lat: -9.3720, lng: -40.5100 },
]

const BUYERS: Seller[] = [
  { name: 'Restaurante Sabor do Sertão', cnpj: '66666666000106', email: 'comprador1@gasbid.com.br', phone: '87999990201', contact: 'João Pereira', street: 'Av. Guararapes', number: '500', neighborhood: 'Centro', zipCode: '56302100', lat: -9.3920, lng: -40.5060 },
  { name: 'Padaria Vale do São Francisco', cnpj: '77777777000107', email: 'comprador2@gasbid.com.br', phone: '87999990202', contact: 'Fernanda Costa', street: 'Rua José de Sá', number: '78', neighborhood: 'Vila Mocó', zipCode: '56304000', lat: -9.3955, lng: -40.4980 },
  { name: 'Hotel Orla Petrolina', cnpj: '88888888000108', email: 'comprador3@gasbid.com.br', phone: '87999990203', contact: 'Ricardo Melo', street: 'Av. Cardoso de Sá', number: '1500', neighborhood: 'Orla', zipCode: '56328000', lat: -9.3990, lng: -40.4890 },
]

async function upsertCompanyWithUser(s: Seller, role: 'SUPPLIER' | 'BUYER', hash: string) {
  const company = await prisma.company.upsert({
    where: { cnpj: s.cnpj },
    update: { name: s.name, email: s.email, phone: s.phone, active: true },
    create: { name: s.name, cnpj: s.cnpj, email: s.email, phone: s.phone, role },
  })

  // Endereço: recria o principal para não duplicar
  await prisma.address.deleteMany({ where: { companyId: company.id } })
  await prisma.address.create({
    data: {
      companyId: company.id,
      street: s.street,
      number: s.number,
      neighborhood: s.neighborhood,
      city: CITY,
      state: STATE,
      zipCode: s.zipCode,
      latitude: s.lat,
      longitude: s.lng,
      isMain: true,
    },
  })

  await prisma.user.upsert({
    where: { email: s.email },
    update: { passwordHash: hash, companyId: company.id, role },
    create: { name: s.contact, email: s.email, passwordHash: hash, role, companyId: company.id },
  })

  return company
}

async function main() {
  console.log('🌱 Seeding database...')

  // 1. Remove todas as cotações (e o que depende delas)
  await prisma.$transaction([
    prisma.supplierRating.deleteMany(),
    prisma.orderMessage.deleteMany(),
    prisma.orderTimeline.deleteMany(),
    prisma.order.deleteMany(),
    prisma.supplierProposalItem.deleteMany(),
    prisma.supplierProposal.deleteMany(),
    prisma.buyerRequestItem.deleteMany(),
    prisma.buyerRequest.deleteMany(),
  ])
  console.log('🧹 Cotações, propostas e pedidos removidos')

  // 2. Produtos
  const products = await Promise.all(
    [
      { sku: 'GLP-P13', name: 'GLP P13 (13kg)', description: 'Botijão de gás GLP 13kg, uso residencial e comercial', weightKg: 13, price: 110 },
      { sku: 'GLP-P20', name: 'GLP P20 (20kg)', description: 'Botijão de gás GLP 20kg, uso comercial', weightKg: 20, price: 190 },
      { sku: 'GLP-P45', name: 'GLP P45 (45kg)', description: 'Cilindro de gás GLP 45kg, uso industrial', weightKg: 45, price: 420 },
    ].map(async ({ price, ...p }) => ({
      price,
      product: await prisma.product.upsert({
        where: { sku: p.sku },
        update: {},
        create: { ...p, unit: 'unidade' },
      }),
    })),
  )
  console.log('✅ Produtos:', products.map((p) => p.product.sku).join(', '))

  const hash = await bcrypt.hash(PASSWORD, 10)

  // 3. Admin
  const adminCompany = await prisma.company.upsert({
    where: { cnpj: '00000000000000' },
    update: {},
    create: { name: 'GasBid Plataforma', cnpj: '00000000000000', email: 'admin@gasbid.com.br', role: 'ADMIN' },
  })
  await prisma.user.upsert({
    where: { email: 'admin@gasbid.com.br' },
    update: { passwordHash: hash },
    create: { name: 'Admin GasBid', email: 'admin@gasbid.com.br', passwordHash: hash, role: 'ADMIN', companyId: adminCompany.id },
  })

  // 4. Revendas (com cobertura em Petrolina e catálogo de produtos)
  for (const [i, s] of SUPPLIERS.entries()) {
    const company = await upsertCompanyWithUser(s, 'SUPPLIER', hash)

    await prisma.supplierCoverage.upsert({
      where: { id: `coverage-petrolina-${company.id}` },
      update: {},
      create: { id: `coverage-petrolina-${company.id}`, supplierCompanyId: company.id, city: CITY, state: STATE, radiusKm: 30 },
    })

    for (const { product, price } of products) {
      const defaultPrice = price + i * 2 // pequenas variações de preço entre revendas
      await prisma.supplierProduct.upsert({
        where: { supplierCompanyId_productId: { supplierCompanyId: company.id, productId: product.id } },
        update: { defaultPrice, active: true },
        create: { supplierCompanyId: company.id, productId: product.id, defaultPrice, biddingMode: 'BOTH' },
      })
    }
  }
  console.log(`✅ ${SUPPLIERS.length} revendas criadas em ${CITY}`)

  // 5. Compradores
  for (const b of BUYERS) await upsertCompanyWithUser(b, 'BUYER', hash)
  console.log(`✅ ${BUYERS.length} compradores criados`)

  console.log('')
  console.log(`🔑 Senha de todos os usuários: ${PASSWORD}`)
  console.log('  Admin:       admin@gasbid.com.br')
  SUPPLIERS.forEach((s) => console.log(`  Revenda:     ${s.email}  (${s.neighborhood})`))
  BUYERS.forEach((b) => console.log(`  Comprador:   ${b.email}  (${b.neighborhood})`))
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
