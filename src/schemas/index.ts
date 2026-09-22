import { z } from 'zod'

export const registerSchema = z.object({
  name: z.string().min(2, 'Nome deve ter pelo menos 2 caracteres'),
  email: z.string().email('Email inválido'),
  password: z.string().min(6, 'Senha deve ter pelo menos 6 caracteres'),
  role: z.enum(['BUYER', 'SUPPLIER']).default('BUYER'),
  company: z.object({
    name: z.string().min(2),
    cnpj: z.string().regex(/^\d{14}$/, 'CNPJ deve ter 14 dígitos'),
    phone: z.string().optional(),
    email: z.string().email().optional(),
  }),
})

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
})

export const refreshSchema = z.object({
  refreshToken: z.string().min(1),
})

export const createBuyerRequestSchema = z.object({
  addressId: z.string().cuid(),
  items: z.array(z.object({
    productId: z.string().cuid(),
    quantity: z.number().int().positive('Quantidade deve ser pelo menos 1'),
  })).min(1),
  deadline: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  observations: z.string().optional(),
})

export const createProposalSchema = z.object({
  items: z.array(z.object({
    buyerRequestItemId: z.string().cuid(),
    unitPrice: z.number().positive('Preço deve ser maior que zero'),
  })).min(1),
  freightPrice: z.number().min(0, 'Frete não pode ser negativo').default(0),
  deliveryDeadline: z.string().datetime(),
  paymentTerms: z.string().optional(),
  observations: z.string().optional(),
})

export const updateOrderStatusSchema = z.object({
  status: z.enum(['CONFIRMED', 'IN_DELIVERY', 'DELIVERED', 'CANCELLED']),
  notes: z.string().optional(),
})

export const createAddressSchema = z.object({
  street: z.string().min(1),
  number: z.string().min(1),
  complement: z.string().optional(),
  neighborhood: z.string().min(1),
  city: z.string().min(1),
  state: z.string().length(2),
  zipCode: z.string().regex(/^\d{8}$/, 'CEP deve ter 8 dígitos'),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  isMain: z.boolean().default(false),
})

export const paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20),
})

export const createOrderMessageSchema = z.object({
  content: z.string().min(1, 'Mensagem não pode estar vazia'),
})

export const createSupplierProductSchema = z.object({
  productId: z.string().cuid(),
  active: z.boolean().optional(),
  biddingMode: z.enum(['AUTO_ONLY', 'MANUAL_ONLY', 'BOTH']).optional(),
  defaultPrice: z.number().nullable().optional(),
})

export const addSupplierProductSchema = createSupplierProductSchema

export const updateSupplierProductSchema = z.object({
  active: z.boolean().optional(),
  biddingMode: z.enum(['AUTO_ONLY', 'MANUAL_ONLY', 'BOTH']).optional(),
  defaultPrice: z.number().nullable().optional(),
})
