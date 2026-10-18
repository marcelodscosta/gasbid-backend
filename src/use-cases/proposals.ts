import { prisma } from '../lib/prisma'
import { NotFoundError, ForbiddenError, AppError } from '../errors/app-error'
import { wsManager } from '../lib/ws'
import { sendPushToCompany, sendPushToSuppliers } from '../services/push-notification'
import { proposalTotal, round2 } from '../lib/money'
import { ACCEPTABLE_PROPOSAL_STATUSES, ACCEPTING_STATUSES, MIN_BID_DECREMENT } from '../lib/state-machine'

interface CreateProposalInput {
  buyerRequestId: string
  supplierCompanyId: string
  items: {
    buyerRequestItemId: string
    unitPrice: number
  }[]
  freightPrice: number
  deliveryDeadline: string
  paymentTerms?: string
  observations?: string
}

/**
 * Cria ou atualiza o lance de um fornecedor.
 *
 * Regra única (proposta nova ou atualização): havendo concorrente, o novo total precisa
 * ser ao menos MIN_BID_DECREMENT menor que a menor oferta rival — exceto quando o fornecedor
 * já lidera (pode ajustar livremente) ou está respondendo a uma contraproposta.
 *
 * A solicitação é travada (SELECT ... FOR UPDATE) durante a validação+gravação, então
 * lances simultâneos são serializados e não há corrida entre "ler concorrentes" e "gravar".
 */
export async function createProposalUseCase(data: CreateProposalInput) {
  const { items, ...proposalData } = data

  const outcome = await prisma.$transaction(async tx => {
    await tx.$queryRaw`SELECT "id" FROM "buyer_requests" WHERE "id" = ${data.buyerRequestId} FOR UPDATE`

    const request = await tx.buyerRequest.findUnique({
      where: { id: data.buyerRequestId },
      include: { items: true },
    })
    if (!request) throw new NotFoundError('Solicitação')
    if (request.status !== 'OPEN') throw new AppError('Solicitação não está aberta para propostas')
    if (request.expiresAt < new Date()) throw new AppError('Prazo para envio de propostas encerrado')

    const requestItemIds = new Set(request.items.map(i => i.id))
    const sentIds = items.map(i => i.buyerRequestItemId)
    if (new Set(sentIds).size !== sentIds.length || sentIds.some(id => !requestItemIds.has(id))) {
      throw new AppError('Itens da proposta inválidos para esta solicitação')
    }
    if (sentIds.length !== requestItemIds.size) {
      throw new AppError('A proposta precisa informar o preço de todos os itens da solicitação')
    }

    const existing = await tx.supplierProposal.findUnique({
      where: {
        buyerRequestId_supplierCompanyId: {
          buyerRequestId: data.buyerRequestId,
          supplierCompanyId: data.supplierCompanyId,
        },
      },
      include: { items: { include: { buyerRequestItem: true } } },
    })

    const isCounterOffer = existing?.status === 'COUNTER_OFFER'
    if (new Date(data.deliveryDeadline) > request.deadline && !isCounterOffer) {
      throw new AppError(
        `O prazo de entrega informado ultrapassa o limite exigido pelo comprador (${request.deadline.toLocaleString('pt-BR')}). Se precisar de mais prazo, negocie via contraproposta.`,
      )
    }

    const newGrandTotal = proposalTotal(
      items.map(item => ({
        unitPrice: item.unitPrice,
        quantity: request.items.find(ri => ri.id === item.buyerRequestItemId)?.quantity,
      })),
      data.freightPrice || 0,
    )

    const competitors = await tx.supplierProposal.findMany({
      where: {
        buyerRequestId: data.buyerRequestId,
        status: { notIn: ['WITHDRAWN', 'REJECTED'] },
        supplierCompanyId: { not: data.supplierCompanyId },
      },
      include: { items: { include: { buyerRequestItem: true } } },
    })
    const competitorTotals = competitors.map(p => ({
      supplierCompanyId: p.supplierCompanyId,
      total: proposalTotal(p.items, p.freightPrice),
    }))
    const lowestOther = competitorTotals.length ? Math.min(...competitorTotals.map(c => c.total)) : Infinity

    if (!isCounterOffer && lowestOther < Infinity) {
      const isActive = !!existing && !['WITHDRAWN', 'REJECTED'].includes(existing.status)
      const alreadyLeading = isActive && proposalTotal(existing!.items, existing!.freightPrice) < lowestOther
      if (!alreadyLeading) {
        const maxAllowed = round2(lowestOther - MIN_BID_DECREMENT)
        if (newGrandTotal > maxAllowed) {
          throw new AppError(
            `Para cobrir a menor oferta atual (R$ ${lowestOther.toFixed(2)}), sua proposta precisa ser de no máximo R$ ${maxAllowed.toFixed(2)} (diferença mínima de R$ ${MIN_BID_DECREMENT.toFixed(2).replace('.', ',')}).`,
          )
        }
      }
    }

    const include = {
      supplierCompany: { select: { id: true, name: true } },
      items: true,
    }
    const itemsData = items.map(item => ({
      buyerRequestItemId: item.buyerRequestItemId,
      unitPrice: item.unitPrice,
    }))

    const proposal = existing
      ? await tx.supplierProposal.update({
          where: { id: existing.id },
          data: {
            freightPrice: data.freightPrice,
            deliveryDeadline: new Date(data.deliveryDeadline),
            paymentTerms: data.paymentTerms,
            observations: data.observations,
            status: 'UPDATED',
            items: { deleteMany: {}, create: itemsData },
          },
          include,
        })
      : await tx.supplierProposal.create({
          data: {
            ...proposalData,
            deliveryDeadline: new Date(data.deliveryDeadline),
            status: 'SUBMITTED',
            items: { create: itemsData },
          },
          include,
        })

    return { proposal, request, competitorTotals, newGrandTotal, isUpdate: !!existing }
  })

  notifyBidActivity(data.buyerRequestId, outcome)
  return outcome.proposal
}

/** Avisa comprador e concorrentes superados (criação OU atualização). Nunca derruba o lance. */
function notifyBidActivity(
  buyerRequestId: string,
  o: {
    proposal: { supplierCompany: { name: string } }
    request: { buyerCompanyId: string }
    competitorTotals: { supplierCompanyId: string; total: number }[]
    newGrandTotal: number
    isUpdate: boolean
  },
) {
  try {
    const event = o.isUpdate ? 'PROPOSAL_UPDATED' : 'PROPOSAL_RECEIVED'
    wsManager.notifyCompany(o.request.buyerCompanyId, event, { buyerRequestId })
    sendPushToCompany(
      o.request.buyerCompanyId,
      o.isUpdate ? 'Proposta atualizada! 🔄' : 'Nova proposta recebida! 📩',
      `${o.proposal.supplierCompany.name} ${o.isUpdate ? 'atualizou a proposta para' : 'enviou uma proposta de'} R$ ${o.newGrandTotal.toFixed(2)}.`,
      { type: event, buyerRequestId },
    )

    const outbid = o.competitorTotals.filter(c => o.newGrandTotal < c.total).map(c => c.supplierCompanyId)
    if (outbid.length > 0) {
      wsManager.notifyCompanies(outbid, 'PROPOSAL_OUTBID', { buyerRequestId })
      sendPushToSuppliers(
        outbid,
        'Sua proposta foi superada! ⚠️',
        'Um concorrente ofereceu um preço menor. Atualize sua proposta para continuar competindo.',
        { type: 'PROPOSAL_OUTBID', buyerRequestId },
      )
    }
  } catch (err) {
    console.error('Error sending bid notifications', err)
  }
}

export async function listProposalsUseCase(buyerRequestId: string, buyerCompanyId: string) {
  const request = await prisma.buyerRequest.findUnique({ where: { id: buyerRequestId } })
  if (!request) throw new NotFoundError('Solicitação')
  if (request.buyerCompanyId !== buyerCompanyId) throw new ForbiddenError()

  return prisma.supplierProposal.findMany({
    where: {
      buyerRequestId,
      status: { not: 'WITHDRAWN' },
    },
    include: {
      supplierCompany: { 
        select: { 
          id: true, 
          name: true, 
          cnpj: true,
          ratingAvg: true,
          ratingCount: true,
        } 
      },
      items: { include: { buyerRequestItem: { include: { product: true } } } }
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function listSupplierProposalsUseCase(supplierCompanyId: string) {
  return prisma.supplierProposal.findMany({
    where: { supplierCompanyId },
    include: {
      items: { include: { buyerRequestItem: { include: { product: true } } } },
      buyerRequest: {
        include: {
          items: { include: { product: true } },
          address: true,
          buyerCompany: { select: { id: true, name: true } },
        },
      },
    },
    orderBy: { createdAt: 'desc' },
  })
}

export async function acceptProposalUseCase(proposalId: string, buyerCompanyId: string) {
  const proposal = await prisma.supplierProposal.findUnique({
    where: { id: proposalId },
    include: {
      buyerRequest: { include: { items: true } },
      items: true
    },
  })
  if (!proposal) throw new NotFoundError('Proposta')
  if (proposal.buyerRequest.buyerCompanyId !== buyerCompanyId) throw new ForbiddenError()
  // Aceita também UNDER_REVIEW: é o estado após "Finalizar busca" e após o fornecedor não confirmar
  if (!ACCEPTING_STATUSES.includes(proposal.buyerRequest.status)) {
    throw new AppError('Solicitação não está mais aberta')
  }
  if (!(ACCEPTABLE_PROPOSAL_STATUSES as readonly string[]).includes(proposal.status)) {
    throw new AppError('Esta proposta não está mais disponível para aceite')
  }

  const totalPrice = proposalTotal(
    proposal.items.map(pItem => ({
      unitPrice: pItem.unitPrice,
      quantity: proposal.buyerRequest.items.find(i => i.id === pItem.buyerRequestItemId)?.quantity ?? 0,
    })),
    proposal.freightPrice,
  )

  const orderInclude = {
    buyerRequest: { include: { items: { include: { product: true } } } },
    proposal: { include: { items: true } },
    buyerCompany: { select: { id: true, name: true } },
    supplierCompany: { select: { id: true, name: true } },
  }

  // Claims atômicos: só prossegue se a solicitação e a proposta ainda estiverem disponíveis
  // (evita pedidos duplicados em aceites concorrentes). As demais propostas NÃO são rejeitadas
  // aqui: se o fornecedor não confirmar, o comprador ainda pode escolher outra (ver cron/orders).
  const order = await prisma.$transaction(async tx => {
    const claimed = await tx.buyerRequest.updateMany({
      where: { id: proposal.buyerRequestId, status: { in: ACCEPTING_STATUSES } },
      data: { status: 'AWARDED' },
    })
    if (claimed.count === 0) throw new AppError('Solicitação não está mais aberta')

    const accepted = await tx.supplierProposal.updateMany({
      where: { id: proposalId, status: { in: [...ACCEPTABLE_PROPOSAL_STATUSES] } },
      data: { status: 'ACCEPTED' },
    })
    if (accepted.count === 0) throw new AppError('Esta proposta não está mais disponível para aceite')

    // Order.buyerRequestId é único: após cancelamento por falta de confirmação, o pedido é reaproveitado
    const previous = await tx.order.findUnique({
      where: { buyerRequestId: proposal.buyerRequestId },
      select: { id: true, status: true },
    })
    if (previous) {
      if (previous.status !== 'CANCELLED') throw new AppError('Já existe um pedido ativo para esta solicitação')
      // A conversa anterior era com outro fornecedor (pedido nunca confirmado)
      await tx.orderMessage.deleteMany({ where: { orderId: previous.id } })
      return tx.order.update({
        where: { id: previous.id },
        data: {
          proposalId,
          supplierCompanyId: proposal.supplierCompanyId,
          totalPrice,
          status: 'PENDING_CONFIRMATION',
          confirmedAt: null,
          deliveredAt: null,
          createdAt: new Date(), // reinicia a janela de 5 min de confirmação
          timeline: {
            create: { status: 'PENDING_CONFIRMATION', notes: 'Novo fornecedor selecionado. Aguardando aceite de despacho.' },
          },
        },
        include: orderInclude,
      })
    }

    return tx.order.create({
      data: {
        buyerRequestId: proposal.buyerRequestId,
        proposalId,
        buyerCompanyId: proposal.buyerRequest.buyerCompanyId,
        supplierCompanyId: proposal.supplierCompanyId,
        totalPrice,
        status: 'PENDING_CONFIRMATION',
        timeline: {
          create: { status: 'PENDING_CONFIRMATION', notes: 'Pedido criado. Aguardando aceite de despacho do fornecedor.' },
        },
      },
      include: orderInclude,
    })
  })

  try {
    // Notify all suppliers who competed or had proposals for this request that it's closed/awarded
    const competingProposals = await prisma.supplierProposal.findMany({
      where: { buyerRequestId: proposal.buyerRequestId },
      select: { supplierCompanyId: true }
    })
    const competingCompanyIds = Array.from(new Set(competingProposals.map(p => p.supplierCompanyId)))

    const usersToNotify = await prisma.user.findMany({
      where: { 
        OR: [
          { companyId: { in: [order.buyerCompanyId, order.supplierCompanyId] } },
          { companyId: { in: competingCompanyIds }, role: 'SUPPLIER' }
        ]
      },
      select: { id: true, companyId: true }
    })

    usersToNotify.forEach(user => {
      if (user.companyId === order.buyerCompanyId || user.companyId === order.supplierCompanyId) {
        wsManager.notifyUser(user.id, 'ORDER_CREATED', { orderId: order.id, buyerRequestId: proposal.buyerRequestId })
      } else {
        wsManager.notifyUser(user.id, 'REQUEST_CLOSED', { buyerRequestId: proposal.buyerRequestId, reason: 'O comprador já escolheu uma proposta. Oportunidade finalizada.' })
      }
    })

    // Push para o vencedor
    sendPushToCompany(
      order.supplierCompanyId,
      'Você venceu o leilão! 🎉',
      `Sua proposta de R$ ${totalPrice.toFixed(2)} foi aceita por ${order.buyerCompany.name}. Confirme o pedido.`,
      { type: 'ORDER_CREATED', orderId: order.id, buyerRequestId: proposal.buyerRequestId }
    )

    // Push para os perdedores
    const loserCompanyIds = competingCompanyIds.filter(id => id !== order.supplierCompanyId)
    if (loserCompanyIds.length > 0) {
      sendPushToSuppliers(
        loserCompanyIds,
        'Oportunidade finalizada',
        'O comprador já escolheu outra proposta para esta solicitação.',
        { type: 'REQUEST_CLOSED', buyerRequestId: proposal.buyerRequestId }
      )
    }
  } catch (err) {
    console.error('Error sending WS notification', err)
  }

  return order
}

export async function rejectProposalUseCase(proposalId: string, buyerCompanyId: string) {
  const proposal = await prisma.supplierProposal.findUnique({
    where: { id: proposalId },
    include: { buyerRequest: true },
  })
  if (!proposal) throw new NotFoundError('Proposta')
  if (proposal.buyerRequest.buyerCompanyId !== buyerCompanyId) throw new ForbiddenError()

  const updated = await prisma.supplierProposal.update({
    where: { id: proposalId },
    data: { status: 'REJECTED' },
  })

  try {
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: proposal.supplierCompanyId },
      select: { id: true }
    })
    usersToNotify.forEach(user => {
      wsManager.notifyUser(user.id, 'PROPOSAL_REJECTED', {
        proposalId,
        buyerRequestId: proposal.buyerRequestId
      })
    })

    // Push para o fornecedor rejeitado
    sendPushToCompany(
      proposal.supplierCompanyId,
      'Proposta não aceita',
      'Sua proposta não foi selecionada pelo comprador.',
      { type: 'PROPOSAL_REJECTED', proposalId, buyerRequestId: proposal.buyerRequestId }
    )
  } catch (err) {
    console.error('Error sending WS notification', err)
  }

  return updated
}

export async function counterProposalUseCase(
  proposalId: string,
  buyerCompanyId: string,
  notes: string
) {
  const proposal = await prisma.supplierProposal.findUnique({
    where: { id: proposalId },
    include: { buyerRequest: true },
  })
  if (!proposal) throw new NotFoundError('Proposta')
  if (proposal.buyerRequest.buyerCompanyId !== buyerCompanyId) throw new ForbiddenError()

  const updated = await prisma.supplierProposal.update({
    where: { id: proposalId },
    data: {
      status: 'COUNTER_OFFER',
      observations: notes
    },
  })

  try {
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: proposal.supplierCompanyId },
      select: { id: true }
    })
    usersToNotify.forEach(user => {
      wsManager.notifyUser(user.id, 'COUNTER_OFFER_RECEIVED', {
        proposalId,
        buyerRequestId: proposal.buyerRequestId
      })
    })

    // Push para o fornecedor
    sendPushToCompany(
      proposal.supplierCompanyId,
      'Contra-proposta do comprador 💬',
      'O comprador respondeu sua proposta com uma sugestão. Confira!',
      { type: 'COUNTER_OFFER_RECEIVED', proposalId, buyerRequestId: proposal.buyerRequestId }
    )
  } catch (err) {
    console.error('Error sending WS notification', err)
  }

  return updated
}
