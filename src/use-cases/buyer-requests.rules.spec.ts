import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  cancelBuyerRequestUseCase,
  createBuyerRequestUseCase,
  expireStaleRequestsUseCase,
  updateBuyerRequestStatusUseCase,
} from './buyer-requests'
import { prisma } from '../lib/prisma'
import { AppError } from '../errors/app-error'

vi.mock('../lib/prisma', () => ({
  prisma: {
    order: { findFirst: vi.fn() },
    address: { findFirst: vi.fn(), findMany: vi.fn() },
    systemSetting: { findUnique: vi.fn() },
    buyerRequest: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    supplierCoverage: { findMany: vi.fn() },
    supplierProduct: { findMany: vi.fn() },
    supplierProposal: { findMany: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock('../lib/ws', () => ({
  regionKey: (c: string, s: string) => `${c}|${s}`,
  wsManager: { notifyUser: vi.fn(), notifyCompany: vi.fn(), notifyCompanies: vi.fn(), broadcast: vi.fn() },
}))
vi.mock('../services/push-notification', () => ({ sendPushToSuppliers: vi.fn(), sendPushToCompany: vi.fn() }))

const future = () => new Date(Date.now() + 24 * 3600_000).toISOString()

describe('Regras de cotação (BuyerRequest)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(prisma.order.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.buyerRequest.findFirst).mockResolvedValue(null)
    vi.mocked(prisma.address.findFirst).mockResolvedValue({ id: 'addr', city: 'Petrolina', state: 'PE' } as any)
    vi.mocked(prisma.systemSetting.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.supplierCoverage.findMany).mockResolvedValue([])
  })

  describe('criação', () => {
    const input = () => ({
      buyerCompanyId: 'buyer-1',
      addressId: 'addr',
      items: [{ productId: 'p1', quantity: 1 }],
      deadline: future(),
    })

    it('REGRESSÃO #2: pedido PENDING_CONFIRMATION conta como ativo e bloqueia nova cotação', async () => {
      vi.mocked(prisma.order.findFirst).mockResolvedValue({ id: 'o' } as any)
      await expect(createBuyerRequestUseCase(input())).rejects.toThrow(/pedido em andamento/)

      const where = (vi.mocked(prisma.order.findFirst).mock.calls[0][0] as any).where
      expect(where.status.in).toEqual(['PENDING_CONFIRMATION', 'CONFIRMED', 'IN_DELIVERY'])
    })

    it('impede duas cotações abertas (OPEN/UNDER_REVIEW) do mesmo comprador', async () => {
      vi.mocked(prisma.buyerRequest.findFirst).mockResolvedValue({ id: 'r' } as any)
      await expect(createBuyerRequestUseCase(input())).rejects.toThrow(/cotação aberta/)

      const where = (vi.mocked(prisma.buyerRequest.findFirst).mock.calls[0][0] as any).where
      expect(where.status.in).toEqual(['OPEN', 'UNDER_REVIEW'])
      expect(prisma.buyerRequest.create).not.toHaveBeenCalled()
    })

    it('rejeita produto repetido e prazo no passado', async () => {
      await expect(
        createBuyerRequestUseCase({ ...input(), items: [{ productId: 'p1', quantity: 1 }, { productId: 'p1', quantity: 2 }] }),
      ).rejects.toThrow(/repetido/)
      await expect(
        createBuyerRequestUseCase({ ...input(), deadline: new Date(Date.now() - 1000).toISOString() }),
      ).rejects.toThrow(/futuro/)
    })

    it('grava a forma de pagamento na coluna própria', async () => {
      vi.mocked(prisma.buyerRequest.create).mockResolvedValue({ id: 'r', items: [] } as any)
      await createBuyerRequestUseCase({ ...input(), paymentMethod: 'PIX' })
      expect(prisma.buyerRequest.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ paymentMethod: 'PIX' }) }),
      )
    })
  })

  describe('REGRESSÃO #5: cancelar', () => {
    it('não cancela cotação AWARDED (já virou pedido)', async () => {
      vi.mocked(prisma.buyerRequest.findUnique).mockResolvedValue({ id: 'r', buyerCompanyId: 'b', status: 'AWARDED', proposals: [] } as any)
      await expect(cancelBuyerRequestUseCase('r', 'b')).rejects.toThrow(/virou pedido/)
      expect(prisma.buyerRequest.update).not.toHaveBeenCalled()
    })

    it.each(['OPEN', 'UNDER_REVIEW', 'DRAFT'])('cancela cotação %s', async status => {
      vi.mocked(prisma.buyerRequest.findUnique).mockResolvedValue({ id: 'r', buyerCompanyId: 'b', status, proposals: [] } as any)
      vi.mocked(prisma.buyerRequest.update).mockResolvedValue({ id: 'r', status: 'CANCELLED' } as any)
      await expect(cancelBuyerRequestUseCase('r', 'b')).resolves.toBeTruthy()
    })

    it.each(['CANCELLED', 'EXPIRED'])('não cancela cotação já %s', async status => {
      vi.mocked(prisma.buyerRequest.findUnique).mockResolvedValue({ id: 'r', buyerCompanyId: 'b', status, proposals: [] } as any)
      await expect(cancelBuyerRequestUseCase('r', 'b')).rejects.toThrow(AppError)
    })
  })

  describe('REGRESSÃO #4: PATCH /status', () => {
    it.each(['AWARDED', 'OPEN', 'EXPIRED', 'DRAFT', 'QUALQUER'])('comprador não pode definir %s manualmente', async status => {
      await expect(updateBuyerRequestStatusUseCase('r', 'b', status)).rejects.toThrow(/manualmente/)
      expect(prisma.buyerRequest.update).not.toHaveBeenCalled()
    })

    it('permite OPEN → UNDER_REVIEW ("Finalizar busca")', async () => {
      vi.mocked(prisma.buyerRequest.findUnique).mockResolvedValue({ id: 'r', buyerCompanyId: 'b', status: 'OPEN' } as any)
      vi.mocked(prisma.buyerRequest.update).mockResolvedValue({ id: 'r', status: 'UNDER_REVIEW' } as any)
      vi.mocked(prisma.supplierProposal.findMany).mockResolvedValue([])
      await updateBuyerRequestStatusUseCase('r', 'b', 'UNDER_REVIEW')
      expect(prisma.buyerRequest.update).toHaveBeenCalledWith({ where: { id: 'r' }, data: { status: 'UNDER_REVIEW' } })
    })

    it('não reabre uma cotação cancelada nem altera a de outro comprador', async () => {
      vi.mocked(prisma.buyerRequest.findUnique).mockResolvedValue({ id: 'r', buyerCompanyId: 'b', status: 'CANCELLED' } as any)
      await expect(updateBuyerRequestStatusUseCase('r', 'b', 'UNDER_REVIEW')).rejects.toThrow(/não permitida/)
      await expect(updateBuyerRequestStatusUseCase('r', 'outro', 'UNDER_REVIEW')).rejects.toThrow()
    })
  })

  describe('REGRESSÃO #6: expiração', () => {
    it('marca como EXPIRED cotações sem propostas e fora do prazo, e avisa o comprador', async () => {
      vi.mocked(prisma.buyerRequest.findMany)
        .mockResolvedValueOnce([{ id: 'r1', buyerCompanyId: 'b1' }] as any) // OPEN sem propostas
        .mockResolvedValueOnce([{ id: 'r2', buyerCompanyId: 'b2' }, { id: 'r1', buyerCompanyId: 'b1' }] as any) // prazo vencido
      vi.mocked(prisma.buyerRequest.updateMany).mockResolvedValue({ count: 2 } as any)

      const n = await expireStaleRequestsUseCase(new Date())

      expect(n).toBe(2) // r1 não é contado em duplicidade
      expect(prisma.buyerRequest.updateMany).toHaveBeenCalledWith({
        where: { id: { in: ['r1', 'r2'] }, status: { in: ['OPEN', 'UNDER_REVIEW'] } },
        data: { status: 'EXPIRED' },
      })
    })

    it('não faz update quando não há nada a expirar', async () => {
      vi.mocked(prisma.buyerRequest.findMany).mockResolvedValue([])
      expect(await expireStaleRequestsUseCase(new Date())).toBe(0)
      expect(prisma.buyerRequest.updateMany).not.toHaveBeenCalled()
    })
  })
})
