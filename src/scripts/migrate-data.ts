import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import 'dotenv/config'

async function main() {
  console.log('Fetching data from local database...')
  
  const localAdapter = new PrismaPg({ connectionString: 'postgresql://postgres:postgres@localhost:5432/gasbid' })
  const localPrisma = new PrismaClient({ adapter: localAdapter })
  await localPrisma.$connect()
  
  const companies = await localPrisma.company.findMany()
  const addresses = await localPrisma.address.findMany()
  const users = await localPrisma.user.findMany()
  const products = await localPrisma.product.findMany()
  const supplierProducts = await localPrisma.supplierProduct.findMany()
  const supplierCoverages = await localPrisma.supplierCoverage.findMany()
  const systemSettings = await localPrisma.systemSetting.findMany()

  await localPrisma.$disconnect()

  console.log(`Found ${companies.length} companies, ${users.length} users.`)
  console.log('Inserting into remote database...')

  process.env.DATABASE_URL = 'postgresql://gasbid_db_afd0_user:K3S0OQBIy1caAwPKZmy1J4ljiTa3OE1e@dpg-daoso460tbcc73fhgo40-a.ohio-postgres.render.com/gasbid_db_afd0?sslmode=require'
  const remoteAdapter = new PrismaPg({ connectionString: process.env.DATABASE_URL })
  const remotePrisma = new PrismaClient({ adapter: remoteAdapter })
  await remotePrisma.$connect()

  try {
    if (companies.length > 0) await remotePrisma.company.createMany({ data: companies, skipDuplicates: true })
    console.log('✅ Companies inserted')

    if (addresses.length > 0) await remotePrisma.address.createMany({ data: addresses, skipDuplicates: true })
    console.log('✅ Addresses inserted')

    if (users.length > 0) await remotePrisma.user.createMany({ data: users, skipDuplicates: true })
    console.log('✅ Users inserted')

    if (products.length > 0) await remotePrisma.product.createMany({ data: products, skipDuplicates: true })
    console.log('✅ Products inserted')

    if (supplierProducts.length > 0) await remotePrisma.supplierProduct.createMany({ data: supplierProducts, skipDuplicates: true })
    console.log('✅ Supplier Products inserted')

    if (supplierCoverages.length > 0) await remotePrisma.supplierCoverage.createMany({ data: supplierCoverages, skipDuplicates: true })
    console.log('✅ Supplier Coverages inserted')

    if (systemSettings.length > 0) await remotePrisma.systemSetting.createMany({ data: systemSettings, skipDuplicates: true })
    console.log('✅ System Settings inserted')

    console.log('Migration completed successfully!')
  } catch (error) {
    console.error('Error during migration:', error)
  } finally {
    await localPrisma.$disconnect()
    await remotePrisma.$disconnect()
  }
}

main()
