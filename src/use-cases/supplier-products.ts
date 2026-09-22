import { prisma } from '../lib/prisma'
import { NotFoundError, ForbiddenError, AppError } from '../errors/app-error'

export async function getGlobalProductsUseCase() {
  return prisma.product.findMany({
    where: { active: true },
    orderBy: { name: 'asc' }
  })
}

export async function getSupplierProductsUseCase(supplierCompanyId: string) {
  return prisma.supplierProduct.findMany({
    where: { supplierCompanyId },
    include: { product: true },
    orderBy: { createdAt: 'desc' }
  })
}

export async function addSupplierProductUseCase(supplierCompanyId: string, productId: string) {
  const existing = await prisma.supplierProduct.findUnique({
    where: {
      supplierCompanyId_productId: { supplierCompanyId, productId }
    }
  })
  
  if (existing) {
    throw new AppError('Produto já está associado a este fornecedor.')
  }

  return prisma.supplierProduct.create({
    data: {
      supplierCompanyId,
      productId,
    },
    include: { product: true }
  })
}

export async function updateSupplierProductUseCase(
  id: string,
  supplierCompanyId: string,
  isAdmin: boolean,
  data: {
    active?: boolean,
    biddingMode?: 'AUTO_ONLY' | 'MANUAL_ONLY' | 'BOTH',
    tier1Km?: number | null,
    tier1Price?: number | null,
    tier2Km?: number | null,
    tier2Price?: number | null,
    tier3Km?: number | null,
    tier3Price?: number | null,
    tier4Km?: number | null,
    tier4Price?: number | null,
  }
) {
  const supplierProduct = await prisma.supplierProduct.findUnique({
    where: { id }
  })

  if (!supplierProduct) throw new NotFoundError('Produto do Fornecedor')

  // Only admin or the supplier themselves can update
  if (!isAdmin && supplierProduct.supplierCompanyId !== supplierCompanyId) {
    throw new ForbiddenError()
  }

  // Admin can change 'active', supplier cannot (unless we want them to, but usually admin controls active state for billing/authorization)
  // But supplier can change biddingMode and prices.
  const updateData: any = { ...data }
  if (!isAdmin && data.active !== undefined) {
    delete updateData.active
  }

  return prisma.supplierProduct.update({
    where: { id },
    data: updateData,
    include: { product: true }
  })
}

export async function removeSupplierProductUseCase(id: string, isAdmin: boolean, supplierCompanyId: string) {
  const supplierProduct = await prisma.supplierProduct.findUnique({
    where: { id }
  })

  if (!supplierProduct) throw new NotFoundError('Produto do Fornecedor')

  if (!isAdmin && supplierProduct.supplierCompanyId !== supplierCompanyId) {
    throw new ForbiddenError()
  }

  await prisma.supplierProduct.delete({
    where: { id }
  })
}
