import { describe, it, expect, vi, beforeEach } from 'vitest'
import { acceptProposalUseCase } from './proposals'
import { prisma } from '../lib/prisma'
import { ForbiddenError, NotFoundError, AppError } from '../errors/app-error'

vi.mock('../lib/prisma', () => ({
  prisma: {
    supplierProposal: {
      findUnique: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    buyerRequest: {
      update: vi.fn(),
    },
    order: {
      create: vi.fn(),
    },
    orderTimeline: {
      create: vi.fn(),
    },
    user: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    $transaction: vi.fn((operations) => Promise.all(operations)),
  }
}))

describe('acceptProposalUseCase', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.order.create).mockResolvedValue({ id: 'new-order-id' } as any)
  })

  it('deve retornar NotFoundError se a proposta não existir', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(null)
    await expect(acceptProposalUseCase('inv-prop', 'buyer')).rejects.toThrow(NotFoundError)
  })

  it('deve retornar ForbiddenError se o comprador não for o dono da solicitação', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue({
      id: 'prop-1',
      status: 'SUBMITTED',
      buyerRequest: {
        buyerCompanyId: 'buyer-1',
        status: 'OPEN',
      }
    } as any)
    
    await expect(acceptProposalUseCase('prop-1', 'other-buyer')).rejects.toThrow(ForbiddenError)
  })

  it('deve realizar as atualizações em cascata e criar o pedido com sucesso', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue({
      id: 'prop-1',
      status: 'SUBMITTED',
      supplierCompanyId: 'supplier-1',
      freightPrice: 20,
      buyerRequestId: 'req-1',
      buyerRequest: {
        buyerCompanyId: 'buyer-1',
        status: 'OPEN',
        items: [
          { id: 'req-item-1', quantity: 5 }
        ]
      },
      items: [
        { buyerRequestItemId: 'req-item-1', unitPrice: 100 }
      ]
    } as any)

    const order = await acceptProposalUseCase('prop-1', 'buyer-1')

    expect(prisma.$transaction).toHaveBeenCalled()

    // Preço: (5 * 100) + 20 = 520
    expect(prisma.order.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        totalPrice: 520,
        buyerCompanyId: 'buyer-1',
        supplierCompanyId: 'supplier-1'
      })
    }))

    expect(order.id).toBe('new-order-id')
  })
})
