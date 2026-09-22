// src/schemas/index.ts
import { z } from "zod";
var registerSchema = z.object({
  name: z.string().min(2, "Nome deve ter pelo menos 2 caracteres"),
  email: z.string().email("Email inv\xE1lido"),
  password: z.string().min(6, "Senha deve ter pelo menos 6 caracteres"),
  role: z.enum(["BUYER", "SUPPLIER"]).default("BUYER"),
  company: z.object({
    name: z.string().min(2),
    cnpj: z.string().regex(/^\d{14}$/, "CNPJ deve ter 14 d\xEDgitos"),
    phone: z.string().optional(),
    email: z.string().email().optional()
  })
});
var loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1)
});
var refreshSchema = z.object({
  refreshToken: z.string().min(1)
});
var createBuyerRequestSchema = z.object({
  addressId: z.string().cuid(),
  items: z.array(z.object({
    productId: z.string().cuid(),
    quantity: z.number().int().positive("Quantidade deve ser pelo menos 1")
  })).min(1),
  deadline: z.string().datetime(),
  expiresAt: z.string().datetime().optional(),
  observations: z.string().optional()
});
var createProposalSchema = z.object({
  items: z.array(z.object({
    buyerRequestItemId: z.string().cuid(),
    unitPrice: z.number().positive("Pre\xE7o deve ser maior que zero")
  })).min(1),
  freightPrice: z.number().min(0, "Frete n\xE3o pode ser negativo").default(0),
  deliveryDeadline: z.string().datetime(),
  paymentTerms: z.string().optional(),
  observations: z.string().optional()
});
var updateOrderStatusSchema = z.object({
  status: z.enum(["CONFIRMED", "IN_DELIVERY", "DELIVERED", "CANCELLED"]),
  notes: z.string().optional()
});
var createAddressSchema = z.object({
  street: z.string().min(1),
  number: z.string().min(1),
  complement: z.string().optional(),
  neighborhood: z.string().min(1),
  city: z.string().min(1),
  state: z.string().length(2),
  zipCode: z.string().regex(/^\d{8}$/, "CEP deve ter 8 d\xEDgitos"),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
  isMain: z.boolean().default(false)
});
var paginationSchema = z.object({
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(20)
});
var createOrderMessageSchema = z.object({
  content: z.string().min(1, "Mensagem n\xE3o pode estar vazia")
});

export {
  registerSchema,
  loginSchema,
  refreshSchema,
  createBuyerRequestSchema,
  createProposalSchema,
  updateOrderStatusSchema,
  createAddressSchema,
  paginationSchema,
  createOrderMessageSchema
};
