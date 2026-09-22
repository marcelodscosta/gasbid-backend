import { prisma } from '../lib/prisma'
import { NotFoundError, ForbiddenError, AppError } from '../errors/app-error'
import { wsManager } from '../lib/ws'

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

export async function createProposalUseCase(data: CreateProposalInput) {
  const { items, ...proposalData } = data

  const request = await prisma.buyerRequest.findUnique({ where: { id: data.buyerRequestId } })
  if (!request) throw new NotFoundError('Solicitação')
  if (request.status !== 'OPEN') throw new AppError('Solicitação não está aberta para propostas')
  if (request.expiresAt < new Date()) throw new AppError('Prazo para envio de propostas encerrado')

  // Calculate total price of this new/updated proposal
  const requestItems = await prisma.buyerRequestItem.findMany({ where: { buyerRequestId: data.buyerRequestId } })
  const newItemsTotal = items.reduce((sum, item) => {
    const rItem = requestItems.find(ri => ri.id === item.buyerRequestItemId)
    return sum + (item.unitPrice * (rItem?.quantity || 1))
  }, 0)
  const newGrandTotal = newItemsTotal + (data.freightPrice || 0)

  const existingProposal = await prisma.supplierProposal.findUnique({
    where: {
      buyerRequestId_supplierCompanyId: {
        buyerRequestId: data.buyerRequestId,
        supplierCompanyId: data.supplierCompanyId,
      },
    },
  })

  // Fetch all active proposals EXCLUDING the current supplier's own proposal
  // to get the true lowest competitor price
  const competitorProposals = await prisma.supplierProposal.findMany({
    where: {
      buyerRequestId: data.buyerRequestId,
      status: { notIn: ['WITHDRAWN', 'REJECTED'] },
      supplierCompanyId: { not: data.supplierCompanyId },
    },
    include: { items: { include: { buyerRequestItem: true } } }
  })

  let currentLowestTotal = Infinity
  competitorProposals.forEach(p => {
    const pItemsTotal = p.items.reduce((s, it) => s + (it.unitPrice * it.buyerRequestItem.quantity), 0)
    const pGrandTotal = pItemsTotal + p.freightPrice
    if (pGrandTotal < currentLowestTotal) {
      currentLowestTotal = pGrandTotal
    }
  })

  if (existingProposal) {
    const isCounterOffer = existingProposal.status === 'COUNTER_OFFER'

    // If there's no competitor lower than us, we are already winning — allow any update
    if (!isCounterOffer && currentLowestTotal < Infinity) {
      // Calculate current proposal's grand total
      const myCurrentItems = await prisma.supplierProposalItem.findMany({
        where: { supplierProposalId: existingProposal.id },
        include: { buyerRequestItem: true }
      })
      const myCurrentTotal = myCurrentItems.reduce((s, it) => s + (it.unitPrice * it.buyerRequestItem.quantity), 0) + existingProposal.freightPrice

      const isLosing = currentLowestTotal < myCurrentTotal

      if (isLosing) {
        // If rebidding, new total must be at least R$ 2,00 lower than the competitor's lowest
        const isRebiddingToWin = newGrandTotal <= currentLowestTotal - 2
        if (!isRebiddingToWin) {
          throw new AppError(`Para cobrir a menor oferta atual (R$ ${currentLowestTotal.toFixed(2)}), sua nova proposta precisa ser de no máximo R$ ${(currentLowestTotal - 2).toFixed(2)} (diferença mínima de R$ 2,00).`)
        }
      }
      // If not losing (already winning), allow any update freely
    }

    return prisma.supplierProposal.update({
      where: { id: existingProposal.id },
      data: {
        freightPrice: data.freightPrice,
        deliveryDeadline: new Date(data.deliveryDeadline),
        paymentTerms: data.paymentTerms,
        observations: data.observations,
        status: 'UPDATED',
        items: {
          deleteMany: {},
          create: items.map(item => ({
            buyerRequestItemId: item.buyerRequestItemId,
            unitPrice: item.unitPrice,
          }))
        }
      },
      include: {
        supplierCompany: { select: { id: true, name: true } },
        items: true,
      },
    })
  }


  const result = await prisma.supplierProposal.create({
    data: {
      ...proposalData,
      deliveryDeadline: new Date(data.deliveryDeadline),
      status: 'SUBMITTED',
      items: {
        create: items.map(item => ({
          buyerRequestItemId: item.buyerRequestItemId,
          unitPrice: item.unitPrice,
        }))
      }
    },
    include: {
      supplierCompany: { select: { id: true, name: true } },
      items: true,
    },
  })

  // WebSocket Notification for the Buyer
  try {
    const usersToNotify = await prisma.user.findMany({
      where: { companyId: request.buyerCompanyId },
      select: { id: true }
    })
    usersToNotify.forEach(user => {
      wsManager.notifyUser(user.id, 'PROPOSAL_RECEIVED', { buyerRequestId: data.buyerRequestId })
    })
  } catch (err) {
    console.error('Error sending WS notification', err)
  }

  return result
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
          ratingsReceived: { select: { stars: true } }
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
  if (proposal.buyerRequest.status !== 'OPEN') {
    throw new AppError('Solicitação não está mais aberta')
  }

  // Calculate total price based on items
  let itemsTotal = 0
  proposal.items.forEach(pItem => {
    const rItem = proposal.buyerRequest.items.find(i => i.id === pItem.buyerRequestItemId)
    if (rItem) {
      itemsTotal += pItem.unitPrice * rItem.quantity
    }
  })
  const totalPrice = itemsTotal + proposal.freightPrice

  const [, , , order] = await prisma.$transaction([
    prisma.supplierProposal.update({
      where: { id: proposalId },
      data: { status: 'ACCEPTED' },
    }),
    prisma.supplierProposal.updateMany({
      where: {
        buyerRequestId: proposal.buyerRequestId,
        id: { not: proposalId },
      },
      data: { status: 'REJECTED' },
    }),
    prisma.buyerRequest.update({
      where: { id: proposal.buyerRequestId },
      data: { status: 'AWARDED' },
    }),
    prisma.order.create({
      data: {
        buyerRequestId: proposal.buyerRequestId,
        proposalId,
        buyerCompanyId: proposal.buyerRequest.buyerCompanyId,
        supplierCompanyId: proposal.supplierCompanyId,
        totalPrice,
        status: 'CREATED',
        timeline: {
          create: { status: 'CREATED', notes: 'Pedido criado após aceite da proposta' },
        },
      },
      include: {
        buyerRequest: { include: { items: { include: { product: true } } } },
        proposal: { include: { items: true } },
        buyerCompany: { select: { id: true, name: true } },
        supplierCompany: { select: { id: true, name: true } },
      },
    }),
  ])

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
  } catch (err) {
    console.error('Error sending WS notification', err)
  }

  return updated
}
