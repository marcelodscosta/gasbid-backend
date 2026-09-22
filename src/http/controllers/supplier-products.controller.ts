import { FastifyRequest, FastifyReply } from 'fastify'
// import { JWTUser } from '../middlewares/auth'
type JWTUser = { sub: string; role: string; companyId: string }
import { 
  getGlobalProductsUseCase, 
  getSupplierProductsUseCase, 
  addSupplierProductUseCase, 
  updateSupplierProductUseCase, 
  removeSupplierProductUseCase 
} from '../../use-cases/supplier-products'
import { addSupplierProductSchema, updateSupplierProductSchema } from '../../schemas'

export async function listGlobalProductsController(req: FastifyRequest, reply: FastifyReply) {
  const products = await getGlobalProductsUseCase()
  return reply.send(products)
}

export async function listSupplierProductsController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string }
  
  // If user is admin, they can see any supplier's products. If supplier, they can only see their own.
  const supplierId = user.role === 'ADMIN' ? id : user.companyId
  
  const products = await getSupplierProductsUseCase(supplierId)
  return reply.send(products)
}

export async function listMySupplierProductsController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const products = await getSupplierProductsUseCase(user.companyId)
  return reply.send(products)
}

export async function addSupplierProductController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id: supplierCompanyId } = req.params as { id: string } // The admin passes supplier ID in params
  const { productId } = addSupplierProductSchema.parse(req.body)
  
  const product = await addSupplierProductUseCase(supplierCompanyId, productId)
  return reply.status(201).send(product)
}

export async function updateSupplierProductController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string } // This is the supplierProductId
  
  const data = updateSupplierProductSchema.parse(req.body)
  const isAdmin = user.role === 'ADMIN'
  
  const product = await updateSupplierProductUseCase(id, user.companyId, isAdmin, data)
  return reply.send(product)
}

export async function removeSupplierProductController(req: FastifyRequest, reply: FastifyReply) {
  const user = req.user as JWTUser
  const { id } = req.params as { id: string } // This is the supplierProductId
  const isAdmin = user.role === 'ADMIN'
  
  await removeSupplierProductUseCase(id, isAdmin, user.companyId)
  return reply.status(204).send()
}
