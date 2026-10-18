import { describe, it, expect, vi, beforeEach } from 'vitest'
import { cancelUnconfirmedOrders } from './cron'
import { prisma } from '../lib/prisma'
import { wsManager } from '../lib/ws'
import { sendPushToCompany } from './push-notification'

vi.mock('../lib/prisma', () => ({
  prisma: {
    order: { findMany: vi.fn(), updateMany: vi.fn() },
    orderTimeline: { create: vi.fn() },
    supplierProposal: { update: vi.fn(), count: vi.fn() },
    buyerRequest: { updateMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../lib/ws', () => ({
  wsManager: { notifyCompany: vi.fn(), notifyCompanies: vi.fn(), notifyUser: vi.fn() },
}))
vi.mock('./push-notification', () => ({ sendPushToCompany: vi.fn() }))
vi.mock('../use-cases/buyer-requests', () => ({ expireStaleRequestsUseCase: vi.fn() }))

const stale = {
  id: 'order-1',
  buyerRequestId: 'req-1',
  proposalId: 'prop-1',
  buyerCompanyId: 'buyer-1',
  supplierCompanyId: 'supplier-1',
}

describe('cancelUnconfirmedOrders (cron)', () => {
  const now = new Date('2026-10-18T12:00:00Z')

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.$transaction).mockImplementation(((fn: any) => fn(prisma)) as any)
    vi.mocked(prisma.order.findMany).mockResolvedValue([stale] as any)
    vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 1 } as any)
    vi.mocked(prisma.buyerRequest.updateMany).mockResolvedValue({ count: 1 } as any)
  })

  it('busca somente pedidos PENDING_CONFIRMATION com mais de 5 minutos', async () => {
    await cancelUnconfirmedOrders(now)
    const args = vi.mocked(prisma.order.findMany).mock.calls[0][0] as any
    expect(args.where.status).toBe('PENDING_CONFIRMATION')
    expect(args.where.createdAt.lt).toEqual(new Date(now.getTime() - 5 * 60_000))
  })

  it('REGRESSÃO #3: com alternativas, a cotação vai para UNDER_REVIEW (não OPEN) com prazo estendido', async () => {
    vi.mocked(prisma.supplierProposal.count).mockResolvedValue(2)

    const n = await cancelUnconfirmedOrders(now)

    expect(n).toBe(1)
    expect(prisma.supplierProposal.update).toHaveBeenCalledWith({ where: { id: 'prop-1' }, data: { status: 'REJECTED' } })
    expect(prisma.buyerRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'AWARDED' },
      data: { status: 'UNDER_REVIEW', expiresAt: new Date(now.getTime() + 10 * 60_000) },
    })
    expect(wsManager.notifyCompany).toHaveBeenCalledWith('buyer-1', 'REQUEST_REOPENED', { requestId: 'req-1', alternatives: 2 })
  })

  it('sem outras propostas aceitáveis, a cotação expira', async () => {
    vi.mocked(prisma.supplierProposal.count).mockResolvedValue(0)
    await cancelUnconfirmedOrders(now)
    expect(prisma.buyerRequest.updateMany).toHaveBeenCalledWith({
      where: { id: 'req-1', status: 'AWARDED' },
      data: { status: 'EXPIRED' },
    })
  })

  it('é idempotente: se outra instância/ação já mexeu no pedido, não faz nada nem notifica', async () => {
    vi.mocked(prisma.order.updateMany).mockResolvedValue({ count: 0 } as any)

    const n = await cancelUnconfirmedOrders(now)

    expect(n).toBe(0)
    expect(prisma.orderTimeline.create).not.toHaveBeenCalled()
    expect(prisma.buyerRequest.updateMany).not.toHaveBeenCalled()
    expect(sendPushToCompany).not.toHaveBeenCalled()
  })

  it('avisa fornecedor e comprador', async () => {
    vi.mocked(prisma.supplierProposal.count).mockResolvedValue(1)
    await cancelUnconfirmedOrders(now)
    const targets = vi.mocked(sendPushToCompany).mock.calls.map(c => c[0])
    expect(targets).toEqual(expect.arrayContaining(['supplier-1', 'buyer-1']))
  })
})
