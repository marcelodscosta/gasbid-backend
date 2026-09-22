import { FastifyInstance } from 'fastify'
import { authenticate, requireRole } from '../middlewares/auth'
import {
  listGlobalProductsController,
  listSupplierProductsController,
  listMySupplierProductsController,
  addSupplierProductController,
  updateSupplierProductController,
  removeSupplierProductController
} from '../controllers/supplier-products.controller'

export async function supplierProductRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  // Supplier routes
  app.get('/supplier/products', { preHandler: [requireRole('SUPPLIER')] }, listMySupplierProductsController)
  app.put('/supplier/products/:id', { preHandler: [requireRole('SUPPLIER')] }, updateSupplierProductController)
  
  // Admin routes
  app.get('/admin/products', { preHandler: [requireRole('ADMIN')] }, listGlobalProductsController)
  app.get('/admin/suppliers/:id/products', { preHandler: [requireRole('ADMIN')] }, listSupplierProductsController)
  app.post('/admin/suppliers/:id/products', { preHandler: [requireRole('ADMIN')] }, addSupplierProductController)
  app.put('/admin/supplier-products/:id', { preHandler: [requireRole('ADMIN')] }, updateSupplierProductController)
  app.delete('/admin/supplier-products/:id', { preHandler: [requireRole('ADMIN')] }, removeSupplierProductController)
}
