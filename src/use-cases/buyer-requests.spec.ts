import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createBuyerRequestUseCase, listBuyerRequestsUseCase } from './buyer-requests'
import { prisma } from '../lib/prisma'
import { NotFoundError } from '../errors/app-error'

vi.mock('../lib/prisma', () => ({
  prisma: {
    address: {
      findFirst: vi.fn(),
    },
    order: {
      findFirst: vi.fn(),
    },
    systemSetting: {
      findUnique: vi.fn(),
    },
    buyerRequest: {
      create: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    supplierCoverage: {
      findMany: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
  }
}))

vi.mock('../lib/ws', () => ({
  wsManager: {
    notifyUser: vi.fn(),
  }
}))

describe('BuyerRequests Use Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createBuyerRequestUseCase', () => {
    const input = {
      buyerCompanyId: 'buyer-1',
      addressId: 'addr-1',
      items: [{ productId: 'prod-1', quantity: 10 }],
      deadline: '2026-05-10T10:00:00Z',
      expiresAt: '2026-05-05T10:00:00Z',
    }

    it('deve retornar NotFoundError se o endereço não pertencer à empresa', async () => {
      vi.mocked(prisma.address.findFirst).mockResolvedValue(null)
      
      await expect(createBuyerRequestUseCase(input)).rejects.toThrow(NotFoundError)
    })

    it('deve criar uma solicitação com sucesso e notificar fornecedores', async () => {
      vi.mocked(prisma.address.findFirst).mockResolvedValue({ id: 'addr-1', city: 'São Paulo', state: 'SP' } as any)
      vi.mocked(prisma.buyerRequest.create).mockResolvedValue({ id: 'req-1', ...input } as any)
      vi.mocked(prisma.supplierCoverage.findMany).mockResolvedValue([{ supplierCompanyId: 'supp-1' }] as any)
      vi.mocked(prisma.user.findMany).mockResolvedValue([{ id: 'user-supp-1' }] as any)

      const result = await createBuyerRequestUseCase(input)

      expect(result.id).toBe('req-1')
      expect(prisma.buyerRequest.create).toHaveBeenCalled()
      expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: { companyId: { in: ['supp-1'] }, role: 'SUPPLIER' }
      }))
    })
  })

  describe('listBuyerRequestsUseCase', () => {
    it('deve retornar uma lista paginada de solicitações', async () => {
      vi.mocked(prisma.buyerRequest.findMany).mockResolvedValue([{ id: 'req-1' }] as any)
      vi.mocked(prisma.buyerRequest.count).mockResolvedValue(1)

      const result = await listBuyerRequestsUseCase('buyer-1', 1, 10)

      expect(result.data).toHaveLength(1)
      expect(result.total).toBe(1)
      expect(result.pages).toBe(1)
    })
  })
})
