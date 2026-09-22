import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateOrderStatusUseCase } from './orders'
import { prisma } from '../lib/prisma'
import { ForbiddenError, NotFoundError, AppError } from '../errors/app-error'

vi.mock('../lib/prisma', () => ({
  prisma: {
    order: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    orderTimeline: {
      create: vi.fn(),
    },
    user: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn((ops) => Promise.all(ops.map((op: any) => op))),
  }
}))

vi.mock('../lib/ws', () => ({
  wsManager: {
    notifyUser: vi.fn(),
  }
}))

describe('updateOrderStatusUseCase (State Machine)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.user.findMany).mockResolvedValue([])
  })

  it('deve retornar NotFoundError se o pedido não existir', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(null)
    await expect(updateOrderStatusUseCase('invalid', 'company', 'CONFIRMED')).rejects.toThrow(NotFoundError)
  })

  it('deve retornar ForbiddenError se a empresa não for compradora nem fornecedora do pedido', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: 'order-1',
      buyerCompanyId: 'buyer-1',
      supplierCompanyId: 'supplier-1',
      status: 'CREATED',
    } as any)
    
    await expect(updateOrderStatusUseCase('order-1', 'other-company', 'CONFIRMED')).rejects.toThrow(ForbiddenError)
  })

  it('deve permitir transição válida (ex: CREATED -> CONFIRMED) pelo fornecedor', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: 'order-1',
      buyerCompanyId: 'buyer-1',
      supplierCompanyId: 'supplier-1',
      status: 'CREATED',
    } as any)
    vi.mocked(prisma.order.update).mockResolvedValue({ id: 'order-1' } as any)
    
    const res = await updateOrderStatusUseCase('order-1', 'supplier-1', 'CONFIRMED')
    expect(res.id).toBe('order-1')
    expect(prisma.$transaction).toHaveBeenCalled()
  })

  it('deve permitir transição de IN_DELIVERY -> DELIVERED APENAS pelo comprador', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({
      id: 'order-1',
      buyerCompanyId: 'buyer-1',
      supplierCompanyId: 'supplier-1',
      status: 'IN_DELIVERY',
    } as any)
    vi.mocked(prisma.order.update).mockResolvedValue({ id: 'order-1' } as any)
    
    // Tentar como fornecedor -> Deve falhar
    await expect(updateOrderStatusUseCase('order-1', 'supplier-1', 'DELIVERED')).rejects.toThrow(/Apenas o comprador/)

    // Tentar como comprador -> Deve funcionar
    const res = await updateOrderStatusUseCase('order-1', 'buyer-1', 'DELIVERED')
    expect(res.id).toBe('order-1')
  })
})
