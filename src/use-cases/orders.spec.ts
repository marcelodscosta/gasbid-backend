import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateOrderStatusUseCase } from './orders'
import { prisma } from '../lib/prisma'
import { ForbiddenError, NotFoundError, AppError } from '../errors/app-error'

vi.mock('../lib/prisma', () => ({
  prisma: {
    order: {
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      updateMany: vi.fn(),
    },
    orderTimeline: { create: vi.fn() },
    supplierProposal: { updateMany: vi.fn() },
    user: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))

vi.mock('../lib/ws', () => ({
  wsManager: { notifyUser: vi.fn(), notifyCompany: vi.fn(), notifyCompanies: vi.fn() },
}))

vi.mock('../services/push-notification', () => ({
  sendPushToCompany: vi.fn(),
  sendPushToSuppliers: vi.fn(),
}))

const baseOrder = {
  id: 'order-1',
  buyerCompanyId: 'buyer-1',
  supplierCompanyId: 'supplier-1',
  buyerRequestId: 'req-1',
  proposalId: 'prop-1',
}

describe('updateOrderStatusUseCase (State Machine)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.$transaction).mockImplementation(((fn: any) => fn(prisma)) as any)
    vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
    vi.mocked(prisma.order.findUniqueOrThrow).mockResolvedValue({ id: 'order-1' } as any)
  })

  it('deve retornar NotFoundError se o pedido não existir', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue(null)
    await expect(updateOrderStatusUseCase('invalid', 'company', 'CONFIRMED')).rejects.toThrow(NotFoundError)
  })

  it('deve retornar ForbiddenError se a empresa não for compradora nem fornecedora do pedido', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ ...baseOrder, status: 'CONFIRMED' } as any)
    await expect(updateOrderStatusUseCase('order-1', 'other-company', 'IN_DELIVERY')).rejects.toThrow(ForbiddenError)
  })

  it('fornecedor confirma PENDING_CONFIRMATION → CONFIRMED e as demais propostas são rejeitadas', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ ...baseOrder, status: 'PENDING_CONFIRMATION' } as any)

    const res = await updateOrderStatusUseCase('order-1', 'supplier-1', 'CONFIRMED')

    expect(res.id).toBe('order-1')
    // claim condicional pelo status lido
    expect(prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'order-1', status: 'PENDING_CONFIRMATION' } }),
    )
    expect(prisma.orderTimeline.create).toHaveBeenCalled()
    expect(prisma.supplierProposal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ buyerRequestId: 'req-1', id: { not: 'prop-1' } }),
        data: { status: 'REJECTED' },
      }),
    )
  })

  it('não permite pular etapas (CONFIRMED → DELIVERED)', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ ...baseOrder, status: 'CONFIRMED' } as any)
    await expect(updateOrderStatusUseCase('order-1', 'buyer-1', 'DELIVERED')).rejects.toThrow(/não permitida/)
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
  })

  it('o comprador não pode confirmar nem despachar', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ ...baseOrder, status: 'PENDING_CONFIRMATION' } as any)
    await expect(updateOrderStatusUseCase('order-1', 'buyer-1', 'CONFIRMED')).rejects.toThrow(/Apenas o fornecedor/)
  })

  it('IN_DELIVERY → DELIVERED apenas pelo comprador', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ ...baseOrder, status: 'IN_DELIVERY' } as any)

    await expect(updateOrderStatusUseCase('order-1', 'supplier-1', 'DELIVERED')).rejects.toThrow(/Apenas o comprador/)

    const res = await updateOrderStatusUseCase('order-1', 'buyer-1', 'DELIVERED')
    expect(res.id).toBe('order-1')
  })

  it('o comprador não cancela um pedido que já saiu para entrega', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ ...baseOrder, status: 'IN_DELIVERY' } as any)
    await expect(updateOrderStatusUseCase('order-1', 'buyer-1', 'CANCELLED')).rejects.toThrow(/não pode mais ser cancelado/)
  })

  it('falha se outra ação alterou o pedido no meio (ex.: cron cancelou durante a confirmação)', async () => {
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ ...baseOrder, status: 'PENDING_CONFIRMATION' } as any)
    vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 } as any)

    await expect(updateOrderStatusUseCase('order-1', 'supplier-1', 'CONFIRMED')).rejects.toThrow(AppError)
    expect(prisma.orderTimeline.create).not.toHaveBeenCalled()
    expect(prisma.supplierProposal.updateMany).not.toHaveBeenCalled()
  })
})
