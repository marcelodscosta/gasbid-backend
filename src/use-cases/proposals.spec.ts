import { describe, it, expect, vi, beforeEach } from 'vitest'
import { acceptProposalUseCase, createProposalUseCase } from './proposals'
import { prisma } from '../lib/prisma'
import { wsManager } from '../lib/ws'
import { ForbiddenError, NotFoundError, AppError } from '../errors/app-error'

vi.mock('../lib/prisma', () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
    buyerRequest: { findUnique: vi.fn(), updateMany: vi.fn() },
    supplierProposal: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    order: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    orderMessage: { deleteMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}))

vi.mock('../lib/ws', () => ({
  wsManager: { notifyUser: vi.fn(), notifyCompany: vi.fn(), notifyCompanies: vi.fn() },
}))

vi.mock('../services/push-notification', () => ({
  sendPushToCompany: vi.fn(),
  sendPushToSuppliers: vi.fn(),
}))

const HOUR = 60 * 60 * 1000

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.$transaction).mockImplementation(((fn: any) => fn(prisma)) as any)
  vi.mocked(prisma.user.findMany).mockResolvedValue([])
})

/* -------------------------------------------------------------------------- */
/* Lances                                                                      */
/* -------------------------------------------------------------------------- */
describe('createProposalUseCase (regra de lance)', () => {
  const baseRequest = {
    id: 'req-1',
    status: 'OPEN',
    buyerCompanyId: 'buyer-1',
    expiresAt: new Date(Date.now() + HOUR),
    deadline: new Date(Date.now() + 24 * HOUR),
    items: [{ id: 'ri-1', quantity: 2 }],
  }
  const input = (unitPrice: number, freightPrice = 0, extra: object = {}) => ({
    buyerRequestId: 'req-1',
    supplierCompanyId: 'sup-A',
    items: [{ buyerRequestItemId: 'ri-1', unitPrice }],
    freightPrice,
    deliveryDeadline: new Date(Date.now() + 2 * HOUR).toISOString(),
    ...extra,
  })
  /** Concorrente com total = unitPrice × 2 (+ frete). */
  const rival = (unitPrice: number, supplierCompanyId = 'sup-B', freightPrice = 0) => ({
    supplierCompanyId,
    freightPrice,
    status: 'SUBMITTED',
    items: [{ unitPrice, buyerRequestItem: { quantity: 2 } }],
  })
  const mine = (unitPrice: number, status = 'SUBMITTED') => ({
    id: 'prop-A',
    status,
    freightPrice: 0,
    items: [{ unitPrice, buyerRequestItem: { quantity: 2 } }],
  })

  function setup(opts: { request?: object; existing?: object | null; competitors?: object[] } = {}) {
    vi.mocked(prisma.buyerRequest.findUnique).mockResolvedValue({ ...baseRequest, ...opts.request } as any)
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue((opts.existing ?? null) as any)
    vi.mocked(prisma.supplierProposal.findMany).mockResolvedValue((opts.competitors ?? []) as any)
    const result = { id: 'prop-A', supplierCompany: { id: 'sup-A', name: 'Gás A' }, items: [] }
    vi.mocked(prisma.supplierProposal.create).mockResolvedValue(result as any)
    vi.mocked(prisma.supplierProposal.update).mockResolvedValue(result as any)
  }

  it('trava a solicitação (FOR UPDATE) para serializar lances simultâneos', async () => {
    setup()
    await createProposalUseCase(input(100))
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1)
  })

  it('aceita o primeiro lance quando não há concorrentes', async () => {
    setup()
    await createProposalUseCase(input(100))
    expect(prisma.supplierProposal.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUBMITTED' }) }),
    )
  })

  it('proposta NOVA também precisa cobrir a menor oferta em R$ 2,00 (regra simétrica)', async () => {
    setup({ competitors: [rival(100)] }) // rival: 200
    await expect(createProposalUseCase(input(100))).rejects.toThrow(/diferença mínima/) // empate
    await expect(createProposalUseCase(input(99.5))).rejects.toThrow(/diferença mínima/) // 199 → só R$ 1 abaixo
    expect(prisma.supplierProposal.create).not.toHaveBeenCalled()
  })

  it('aceita exatamente R$ 2,00 abaixo da menor oferta', async () => {
    setup({ competitors: [rival(100), rival(120, 'sup-C')] }) // menor = 200
    await createProposalUseCase(input(99)) // 198
    expect(prisma.supplierProposal.create).toHaveBeenCalled()
  })

  it('considera o frete no total ao comparar', async () => {
    setup({ competitors: [rival(100)] }) // 200
    await expect(createProposalUseCase(input(95, 10))).rejects.toThrow(/diferença mínima/) // 190 + 10 = 200
  })

  it('fornecedor que já lidera pode ajustar o lance livremente', async () => {
    setup({ existing: mine(95), competitors: [rival(100)] }) // eu 190 < rival 200
    await createProposalUseCase(input(99)) // 198: não cobre por R$ 2, mas já lidero
    expect(prisma.supplierProposal.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'UPDATED' }) }),
    )
  })

  it('fornecedor que está perdendo precisa cobrir a menor oferta', async () => {
    setup({ existing: mine(110), competitors: [rival(100)] }) // eu 220 > 200
    await expect(createProposalUseCase(input(100))).rejects.toThrow(/diferença mínima/)
    await createProposalUseCase(input(99))
    expect(prisma.supplierProposal.update).toHaveBeenCalledTimes(1)
  })

  it('proposta REJEITADA anterior volta a competir como lance novo (sem privilégio de líder)', async () => {
    setup({ existing: mine(50, 'REJECTED'), competitors: [rival(100)] })
    await expect(createProposalUseCase(input(99.5))).rejects.toThrow(/diferença mínima/)
  })

  it('contraproposta não está sujeita à diferença mínima', async () => {
    setup({ existing: mine(100, 'COUNTER_OFFER'), competitors: [rival(100)] })
    await createProposalUseCase(input(100))
    expect(prisma.supplierProposal.update).toHaveBeenCalled()
  })

  it('só recebe lances com a solicitação OPEN', async () => {
    setup({ request: { status: 'UNDER_REVIEW' } })
    await expect(createProposalUseCase(input(100))).rejects.toThrow(/não está aberta/)
  })

  it('rejeita lance após o fim da janela de propostas', async () => {
    setup({ request: { expiresAt: new Date(Date.now() - 1000) } })
    await expect(createProposalUseCase(input(100))).rejects.toThrow(/encerrado/)
  })

  it('rejeita itens que não pertencem à solicitação ou proposta incompleta', async () => {
    setup()
    await expect(
      createProposalUseCase({ ...input(100), items: [{ buyerRequestItemId: 'outro', unitPrice: 100 }] }),
    ).rejects.toThrow(/inválidos/)
    await expect(createProposalUseCase({ ...input(100), items: [] })).rejects.toThrow(/todos os itens/)
  })

  it('atualização também notifica o comprador e os concorrentes superados', async () => {
    setup({ existing: mine(110), competitors: [rival(120, 'sup-B'), rival(90, 'sup-C')] })
    // menor rival = 180; precisa ≤ 178 → 89 (178). Os dois rivais (240 e 180) ficam acima de 178.
    await createProposalUseCase(input(89))

    expect(wsManager.notifyCompany).toHaveBeenCalledWith('buyer-1', 'PROPOSAL_UPDATED', { buyerRequestId: 'req-1' })
    expect(wsManager.notifyCompanies).toHaveBeenCalledWith(['sup-B', 'sup-C'], 'PROPOSAL_OUTBID', { buyerRequestId: 'req-1' })
  })

  it('criação notifica o comprador com PROPOSAL_RECEIVED', async () => {
    setup()
    await createProposalUseCase(input(100))
    expect(wsManager.notifyCompany).toHaveBeenCalledWith('buyer-1', 'PROPOSAL_RECEIVED', { buyerRequestId: 'req-1' })
  })
})

/* -------------------------------------------------------------------------- */
/* Aceite                                                                      */
/* -------------------------------------------------------------------------- */
describe('acceptProposalUseCase', () => {
  const proposal = (over: { status?: string; requestStatus?: string } = {}) =>
    ({
      id: 'prop-1',
      status: over.status ?? 'SUBMITTED',
      supplierCompanyId: 'supplier-1',
      freightPrice: 20,
      buyerRequestId: 'req-1',
      buyerRequest: {
        buyerCompanyId: 'buyer-1',
        status: over.requestStatus ?? 'OPEN',
        items: [{ id: 'req-item-1', quantity: 5 }],
      },
      items: [{ buyerRequestItemId: 'req-item-1', unitPrice: 100 }],
    }) as any

  beforeEach(() => {
    vi.mocked(prisma.buyerRequest.updateMany).mockResolvedValue({ count: 1 } as any)
    vi.mocked(prisma.supplierProposal.updateMany).mockResolvedValue({ count: 1 } as any)
    vi.mocked(prisma.order.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.order.create).mockResolvedValue({
      id: 'new-order-id',
      buyerCompanyId: 'buyer-1',
      supplierCompanyId: 'supplier-1',
      buyerCompany: { name: 'Comprador' },
    } as any)
    vi.mocked(prisma.supplierProposal.findMany).mockResolvedValue([])
  })

  it('NotFoundError se a proposta não existir', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(null)
    await expect(acceptProposalUseCase('inv-prop', 'buyer')).rejects.toThrow(NotFoundError)
  })

  it('ForbiddenError se o comprador não for o dono da solicitação', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal())
    await expect(acceptProposalUseCase('prop-1', 'other-buyer')).rejects.toThrow(ForbiddenError)
  })

  it('cria o pedido PENDING_CONFIRMATION com o total correto', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal())

    const order = await acceptProposalUseCase('prop-1', 'buyer-1')

    // (5 × 100) + 20 = 520
    expect(prisma.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          totalPrice: 520,
          status: 'PENDING_CONFIRMATION',
          buyerCompanyId: 'buyer-1',
          supplierCompanyId: 'supplier-1',
        }),
      }),
    )
    expect(order.id).toBe('new-order-id')
  })

  it('REGRESSÃO #1: aceita com a solicitação em UNDER_REVIEW ("Finalizar busca")', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal({ requestStatus: 'UNDER_REVIEW' }))
    const order = await acceptProposalUseCase('prop-1', 'buyer-1')
    expect(order.id).toBe('new-order-id')
    expect(prisma.buyerRequest.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: { in: ['OPEN', 'UNDER_REVIEW'] } }) }),
    )
  })

  it.each(['AWARDED', 'CANCELLED', 'EXPIRED'])('rejeita aceite com a solicitação %s', async requestStatus => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal({ requestStatus }))
    await expect(acceptProposalUseCase('prop-1', 'buyer-1')).rejects.toThrow(/não está mais aberta/)
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it.each(['REJECTED', 'WITHDRAWN', 'ACCEPTED'])('rejeita aceitar proposta %s', async status => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal({ status }))
    await expect(acceptProposalUseCase('prop-1', 'buyer-1')).rejects.toThrow(/não está mais disponível/)
  })

  it('aceita também propostas UPDATED e COUNTER_OFFER', async () => {
    for (const status of ['UPDATED', 'COUNTER_OFFER']) {
      vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal({ status }))
      await expect(acceptProposalUseCase('prop-1', 'buyer-1')).resolves.toBeTruthy()
    }
  })

  it('aceites concorrentes: quem perde o claim da solicitação recebe erro e não cria pedido', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal())
    vi.mocked(prisma.buyerRequest.updateMany).mockResolvedValue({ count: 0 } as any)
    await expect(acceptProposalUseCase('prop-1', 'buyer-1')).rejects.toThrow(AppError)
    expect(prisma.order.create).not.toHaveBeenCalled()
  })

  it('não rejeita as demais propostas no aceite (o comprador pode precisar da 2ª melhor)', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal())
    await acceptProposalUseCase('prop-1', 'buyer-1')
    const rejectedAny = vi
      .mocked(prisma.supplierProposal.updateMany)
      .mock.calls.some(([args]) => (args as any).data?.status === 'REJECTED')
    expect(rejectedAny).toBe(false)
  })

  it('reaproveita o pedido CANCELADO (Order.buyerRequestId é único) ao escolher outra proposta', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal({ requestStatus: 'UNDER_REVIEW' }))
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ id: 'old-order', status: 'CANCELLED' } as any)
    vi.mocked(prisma.order.update).mockResolvedValue({
      id: 'old-order',
      buyerCompanyId: 'buyer-1',
      supplierCompanyId: 'supplier-1',
      buyerCompany: { name: 'Comprador' },
    } as any)

    const order = await acceptProposalUseCase('prop-1', 'buyer-1')

    expect(order.id).toBe('old-order')
    expect(prisma.order.create).not.toHaveBeenCalled()
    expect(prisma.orderMessage.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'old-order' } })
    expect(prisma.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'old-order' },
        data: expect.objectContaining({
          proposalId: 'prop-1',
          status: 'PENDING_CONFIRMATION',
          totalPrice: 520,
          supplierCompanyId: 'supplier-1',
        }),
      }),
    )
  })

  it('bloqueia se já existir um pedido ativo para a solicitação', async () => {
    vi.mocked(prisma.supplierProposal.findUnique).mockResolvedValue(proposal())
    vi.mocked(prisma.order.findUnique).mockResolvedValue({ id: 'o', status: 'CONFIRMED' } as any)
    await expect(acceptProposalUseCase('prop-1', 'buyer-1')).rejects.toThrow(/pedido ativo/)
  })
})
