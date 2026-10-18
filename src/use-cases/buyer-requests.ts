import { BuyerRequestStatus, PaymentMethod } from '@prisma/client'
import { prisma } from '../lib/prisma'
import { NotFoundError, ForbiddenError, AppError } from '../errors/app-error'
import { wsManager, regionKey } from '../lib/ws'
import { calculateDistance } from '../lib/geo'
import { proposalTotal, toNum } from '../lib/money'
import {
  ACTIVE_ORDER_STATUSES,
  BUYER_REQUEST_MANUAL,
  REQUEST_TRANSITIONS,
  canTransition,
} from '../lib/state-machine'
import { sendPushToSuppliers, sendPushToCompany } from '../services/push-notification'

interface CreateRequestInput {
  buyerCompanyId: string
  addressId: string
  items: {
    productId: string
    quantity: number
  }[]
  deadline: string
  expiresAt?: string
  observations?: string
  paymentMethod?: PaymentMethod
}

const OPEN_REQUEST_STATUSES: BuyerRequestStatus[] = ['OPEN', 'UNDER_REVIEW']

async function getProposalWindowMinutes() {
  const windowSetting = await prisma.systemSetting.findUnique({
    where: { key: 'proposal_window_minutes' },
  })
  const parsed = windowSetting ? parseInt(windowSetting.value, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 5
}

export async function createBuyerRequestUseCase(data: CreateRequestInput) {
  const { items, buyerCompanyId, addressId, observations, paymentMethod } = data

  // Produtos duplicados geram itens ambíguos na proposta
  const productIds = items.map(i => i.productId)
  if (new Set(productIds).size !== productIds.length) {
    throw new AppError('Produto repetido na solicitação. Ajuste as quantidades em um único item.')
  }

  const [activeOrder, openRequest, address, windowMinutes] = await Promise.all([
    prisma.order.findFirst({
      where: { buyerCompanyId, status: { in: ACTIVE_ORDER_STATUSES } },
      select: { id: true },
    }),
    prisma.buyerRequest.findFirst({
      where: { buyerCompanyId, status: { in: OPEN_REQUEST_STATUSES } },
      select: { id: true },
    }),
    prisma.address.findFirst({ where: { id: addressId, companyId: buyerCompanyId } }),
    getProposalWindowMinutes(),
  ])

  if (activeOrder) {
    throw new AppError('Você possui um pedido em andamento. Aguarde a conclusão da entrega para realizar um novo pedido.')
  }
  if (openRequest) {
    throw new AppError('Você já possui uma cotação aberta. Finalize ou cancele antes de criar outra.')
  }
  if (!address) throw new NotFoundError('Endereço')

  const deadline = new Date(data.deadline)
  if (deadline.getTime() <= Date.now()) {
    throw new AppError('O prazo de entrega precisa ser no futuro.')
  }

  const request = await prisma.buyerRequest.create({
    data: {
      buyerCompanyId,
      addressId,
      observations,
      paymentMethod,
      deadline,
      expiresAt: new Date(Date.now() + windowMinutes * 60 * 1000),
      status: 'OPEN',
      items: { create: items.map(item => ({ productId: item.productId, quantity: item.quantity })) },
    },
    include: {
      items: { include: { product: true } },
      address: true,
    },
  }).catch(err => {
    // Índice único parcial: duas criações simultâneas do mesmo comprador
    const text = `${(err as any)?.code ?? ''} ${(err as any)?.message ?? ''}`
    if (text.includes('P2002') || text.includes('buyer_requests_one_active_per_buyer')) {
      throw new AppError('Você já possui uma cotação aberta. Finalize ou cancele antes de criar outra.')
    }
    throw err
  })

  // Fornecedores que cobrem a cidade
  const coverages = await prisma.supplierCoverage.findMany({
    where: { city: address.city, state: address.state, supplierCompany: { active: true } },
    select: { supplierCompanyId: true, radiusKm: true },
  })
  const eligibleIds = await filterByRadius(coverages, address)

  // === AUTO-BIDDING ===
  let autoBids = 0
  try {
    autoBids = await runAutoBidding(request, eligibleIds, deadline)
  } catch (err) {
    console.error('Error in auto-bidding logic', err)
  }

  // === NOTIFICAÇÕES ===
  const payload = { requestId: request.id }
  wsManager.notifyCompanies(eligibleIds, 'NEW_OPPORTUNITY', payload)
  wsManager.broadcast(`region:${regionKey(address.city, address.state)}`, 'NEW_OPPORTUNITY', payload)

  if (eligibleIds.length > 0) {
    const itemNames = request.items.map(i => `${i.quantity}x ${i.product.name}`).join(', ')
    sendPushToSuppliers(eligibleIds, 'Nova oportunidade! 🔥', `Pedido de ${itemNames}. Responda agora!`, {
      type: 'NEW_OPPORTUNITY',
      requestId: request.id,
    })
  }
  if (autoBids > 0) {
    wsManager.notifyCompany(buyerCompanyId, 'PROPOSAL_RECEIVED', { buyerRequestId: request.id })
  }

  return request
}

/** Aplica o raio de cobertura (radiusKm) quando definido. */
async function filterByRadius(
  coverages: { supplierCompanyId: string; radiusKm: number | null }[],
  buyerAddress: { latitude: number | null; longitude: number | null },
) {
  const ids = Array.from(new Set(coverages.map(c => c.supplierCompanyId)))
  if (ids.length === 0) return []

  const needsDistance = coverages.some(c => c.radiusKm != null)
  if (!needsDistance) return ids

  const addresses = await prisma.address.findMany({
    where: { companyId: { in: ids } },
    orderBy: { isMain: 'desc' },
    select: { companyId: true, latitude: true, longitude: true },
  })
  const mainAddr = new Map<string, { latitude: number | null; longitude: number | null }>()
  for (const a of addresses) if (!mainAddr.has(a.companyId)) mainAddr.set(a.companyId, a)

  return ids.filter(id => {
    const radius = coverages.find(c => c.supplierCompanyId === id && c.radiusKm != null)?.radiusKm
    if (radius == null) return true
    const s = mainAddr.get(id)
    if (s?.latitude == null || s?.longitude == null || buyerAddress.latitude == null || buyerAddress.longitude == null) {
      return false // raio definido mas sem coordenadas → não dá para garantir cobertura
    }
    return calculateDistance(s.latitude, s.longitude, buyerAddress.latitude, buyerAddress.longitude) <= radius
  })
}

/** Cria propostas automáticas com 1 query de catálogo (sem N+1). */
async function runAutoBidding(
  request: { id: string; items: { id: string; productId: string }[] },
  supplierIds: string[],
  deadline: Date,
) {
  if (supplierIds.length === 0) return 0
  const productIds = request.items.map(i => i.productId)

  const catalog = await prisma.supplierProduct.findMany({
    where: {
      supplierCompanyId: { in: supplierIds },
      productId: { in: productIds },
      active: true,
      biddingMode: { in: ['AUTO_ONLY', 'BOTH'] },
      defaultPrice: { not: null },
    },
    select: { supplierCompanyId: true, productId: true, defaultPrice: true },
  })

  const bySupplier = new Map<string, Map<string, number>>()
  for (const c of catalog) {
    if (!bySupplier.has(c.supplierCompanyId)) bySupplier.set(c.supplierCompanyId, new Map())
    bySupplier.get(c.supplierCompanyId)!.set(c.productId, toNum(c.defaultPrice))
  }

  const creates = []
  for (const [supplierCompanyId, prices] of bySupplier) {
    if (!request.items.every(i => prices.has(i.productId))) continue
    creates.push(
      prisma.supplierProposal.create({
        data: {
          buyerRequestId: request.id,
          supplierCompanyId,
          freightPrice: 0,
          deliveryDeadline: deadline,
          status: 'SUBMITTED',
          observations: 'Proposta automática (catálogo)',
          items: {
            create: request.items.map(i => ({ buyerRequestItemId: i.id, unitPrice: prices.get(i.productId)! })),
          },
        },
      }),
    )
  }
  if (creates.length) await prisma.$transaction(creates)
  return creates.length
}

export async function listBuyerRequestsUseCase(companyId: string, page: number, limit: number) {
  const [data, total] = await Promise.all([
    prisma.buyerRequest.findMany({
      where: { buyerCompanyId: companyId },
      include: {
        items: { include: { product: true } },
        address: true,
        order: { include: { rating: true } },
        _count: { select: { proposals: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.buyerRequest.count({ where: { buyerCompanyId: companyId } }),
  ])
  return { data, total, page, limit, pages: Math.ceil(total / limit) }
}

const supplierCompanySelect = {
  id: true,
  name: true,
  cnpj: true,
  ratingAvg: true,
  ratingCount: true,
  addresses: {
    orderBy: { isMain: 'desc' as const },
    take: 1,
    select: { id: true, latitude: true, longitude: true, city: true, state: true, isMain: true },
  },
}

export async function getBuyerRequestUseCase(id: string, companyId?: string, supplierCompanyId?: string) {
  const request = await prisma.buyerRequest.findUnique({
    where: { id },
    include: {
      items: { include: { product: true } },
      address: true,
      buyerCompany: { select: { id: true, name: true, cnpj: true } },
      proposals: {
        where: supplierCompanyId ? { supplierCompanyId } : { status: { not: 'WITHDRAWN' } },
        include: {
          items: { include: { buyerRequestItem: { include: { product: true } } } },
          supplierCompany: { select: supplierCompanySelect },
        },
        orderBy: { createdAt: 'desc' },
      },
      _count: { select: { proposals: true } },
    },
  })
  if (!request) throw new NotFoundError('Solicitação')

  if (companyId && request.buyerCompanyId !== companyId) {
    throw new ForbiddenError()
  }

  const reqLat = request.address?.latitude
  const reqLng = request.address?.longitude

  // Distância do fornecedor até o comprador (fornecedor vendo a oportunidade)
  let distanceKm: number | null = null
  if (supplierCompanyId && reqLat != null && reqLng != null) {
    const supplierAddress = await prisma.address.findFirst({
      where: { companyId: supplierCompanyId },
      orderBy: { isMain: 'desc' },
    })
    if (supplierAddress?.latitude != null && supplierAddress?.longitude != null) {
      distanceKm = calculateDistance(supplierAddress.latitude, supplierAddress.longitude, reqLat, reqLng)
    }
  }

  // Resumo de mercado para o fornecedor que já deu lance
  let lowestMarketSummary: any = null
  if (supplierCompanyId && request.proposals.length > 0) {
    const allProposals = await prisma.supplierProposal.findMany({
      where: { buyerRequestId: id, status: { notIn: ['WITHDRAWN', 'REJECTED'] } },
      include: { items: { include: { buyerRequestItem: { include: { product: true } } } } },
    })

    let lowestTotal = Infinity
    let lowestProp: (typeof allProposals)[number] | null = null
    for (const prop of allProposals) {
      const total = proposalTotal(prop.items, prop.freightPrice)
      if (total < lowestTotal) {
        lowestTotal = total
        lowestProp = prop
      }
    }
    const myProp = allProposals.find(p => p.supplierCompanyId === supplierCompanyId)
    const myTotal = myProp ? proposalTotal(myProp.items, myProp.freightPrice) : null

    if (lowestProp) {
      lowestMarketSummary = {
        totalPrice: lowestTotal,
        myTotal,
        freightPrice: toNum(lowestProp.freightPrice),
        isMyProposal: myTotal != null && myTotal <= lowestTotal,
        proposalsCount: allProposals.length,
        items: lowestProp.items.map(item => ({
          productId: item.buyerRequestItem.productId,
          productName: item.buyerRequestItem.product.name,
          quantity: item.buyerRequestItem.quantity,
          unitPrice: toNum(item.unitPrice),
          subtotal: toNum(item.unitPrice) * item.buyerRequestItem.quantity,
        })),
      }
    }
  }

  const proposals = request.proposals.map(proposal => {
    const sAddr = proposal.supplierCompany.addresses?.[0]
    let propDistanceKm: number | null = null
    if (sAddr?.latitude != null && sAddr?.longitude != null && reqLat != null && reqLng != null) {
      propDistanceKm = calculateDistance(sAddr.latitude, sAddr.longitude, reqLat, reqLng)
    }
    return {
      ...proposal,
      totalPrice: proposalTotal(proposal.items, proposal.freightPrice),
      distanceKm: propDistanceKm,
    }
  })

  return { ...request, distanceKm, proposals, lowestMarketSummary }
}

export async function listOpportunitiesUseCase(
  supplierCompanyId: string,
  page: number,
  limit: number,
  showApplied = false,
) {
  const coverages = await prisma.supplierCoverage.findMany({ where: { supplierCompanyId } })
  if (coverages.length === 0) return { data: [], total: 0, page, limit, pages: 0 }

  const orConditions = coverages.map(c => ({ address: { city: c.city, state: c.state } }))
  const where: any = {
    status: 'OPEN',
    expiresAt: { gt: new Date() },
    OR: orConditions,
  }
  if (!showApplied) {
    // Mantém as que já tenho proposta (para acompanhar), mas some com as rejeitadas
    where.NOT = { proposals: { some: { supplierCompanyId, status: { in: ['REJECTED', 'WITHDRAWN'] } } } }
  }

  const supplierAddress = await prisma.address.findFirst({
    where: { companyId: supplierCompanyId },
    orderBy: { isMain: 'desc' },
  })

  const [data, total] = await Promise.all([
    prisma.buyerRequest.findMany({
      where,
      include: {
        items: { include: { product: true } },
        address: true,
        buyerCompany: { select: { id: true, name: true } },
        _count: { select: { proposals: true } },
        proposals: { where: { supplierCompanyId }, select: { id: true, status: true } },
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.buyerRequest.count({ where }),
  ])

  const radius = new Map(coverages.map(c => [`${c.city}|${c.state}`, c.radiusKm]))
  const requestsWithDistance = data
    .map(req => {
      let distanceKm: number | null = null
      if (
        supplierAddress?.latitude != null && supplierAddress?.longitude != null &&
        req.address?.latitude != null && req.address?.longitude != null
      ) {
        distanceKm = calculateDistance(supplierAddress.latitude, supplierAddress.longitude, req.address.latitude, req.address.longitude)
      }
      return { ...req, distanceKm }
    })
    .filter(req => {
      const r = radius.get(`${req.address.city}|${req.address.state}`)
      return r == null || req.distanceKm == null || req.distanceKm <= r
    })

  return { data: requestsWithDistance, total, page, limit, pages: Math.ceil(total / limit) }
}

export async function cancelBuyerRequestUseCase(id: string, companyId: string) {
  const request = await prisma.buyerRequest.findUnique({
    where: { id },
    include: { proposals: { select: { supplierCompanyId: true } } },
  })

  if (!request) throw new NotFoundError('Solicitação')
  if (request.buyerCompanyId !== companyId) throw new ForbiddenError()
  if (!canTransition(REQUEST_TRANSITIONS, request.status, 'CANCELLED')) {
    throw new AppError(
      request.status === 'AWARDED'
        ? 'Esta cotação já virou pedido. Cancele o pedido em vez da cotação.'
        : `Não é possível cancelar uma cotação com status ${request.status}`,
    )
  }

  const updatedRequest = await prisma.buyerRequest.update({
    where: { id },
    data: { status: 'CANCELLED' },
  })

  const supplierIds = Array.from(new Set(request.proposals.map(p => p.supplierCompanyId)))
  if (supplierIds.length > 0) {
    wsManager.notifyCompanies(supplierIds, 'OPPORTUNITY_CANCELLED', { requestId: id })
    sendPushToSuppliers(
      supplierIds,
      'Oportunidade cancelada',
      'Uma solicitação em que você enviou proposta foi cancelada pelo comprador.',
      { type: 'OPPORTUNITY_CANCELLED', requestId: id },
    )
  }

  return updatedRequest
}

export async function updateBuyerRequestStatusUseCase(id: string, companyId: string, status: string) {
  const target = status as BuyerRequestStatus
  if (!BUYER_REQUEST_MANUAL.includes(target)) {
    throw new AppError(`Status ${status} não pode ser definido manualmente`)
  }
  if (target === 'CANCELLED') return cancelBuyerRequestUseCase(id, companyId)

  const request = await prisma.buyerRequest.findUnique({ where: { id } })
  if (!request) throw new NotFoundError('Solicitação')
  if (request.buyerCompanyId !== companyId) throw new ForbiddenError()
  if (!canTransition(REQUEST_TRANSITIONS, request.status, target)) {
    throw new AppError(`Transição de ${request.status} → ${target} não permitida`)
  }

  const updated = await prisma.buyerRequest.update({ where: { id }, data: { status: target } })

  if (target === 'UNDER_REVIEW') {
    const props = await prisma.supplierProposal.findMany({
      where: { buyerRequestId: id },
      select: { supplierCompanyId: true },
    })
    wsManager.notifyCompanies(props.map(p => p.supplierCompanyId), 'REQUEST_UNDER_REVIEW', { requestId: id })
  }

  return updated
}

/** Job: marca como EXPIRED as cotações sem decisão. */
export async function expireStaleRequestsUseCase(now = new Date()) {
  // OPEN sem propostas e com janela encerrada
  const openNoProposals = await prisma.buyerRequest.findMany({
    where: { status: 'OPEN', expiresAt: { lt: now }, proposals: { none: {} } },
    select: { id: true, buyerCompanyId: true },
  })
  // Qualquer cotação aberta/em análise cujo prazo de entrega já passou
  const pastDeadline = await prisma.buyerRequest.findMany({
    where: { status: { in: OPEN_REQUEST_STATUSES }, deadline: { lt: now } },
    select: { id: true, buyerCompanyId: true },
  })

  const toExpire = new Map([...openNoProposals, ...pastDeadline].map(r => [r.id, r]))
  if (toExpire.size === 0) return 0

  await prisma.buyerRequest.updateMany({
    where: { id: { in: Array.from(toExpire.keys()) }, status: { in: OPEN_REQUEST_STATUSES } },
    data: { status: 'EXPIRED' },
  })

  for (const r of toExpire.values()) {
    wsManager.notifyCompany(r.buyerCompanyId, 'REQUEST_EXPIRED', { requestId: r.id })
    sendPushToCompany(r.buyerCompanyId, 'Cotação encerrada ⌛', 'Sua cotação expirou sem um pedido. Crie uma nova quando quiser.', {
      type: 'REQUEST_EXPIRED',
      requestId: r.id,
    })
  }
  return toExpire.size
}
