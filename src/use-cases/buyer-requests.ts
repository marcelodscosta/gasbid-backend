import { prisma } from '../lib/prisma'
import { NotFoundError, ForbiddenError, AppError } from '../errors/app-error'
import { wsManager } from '../lib/ws'
import { calculateDistance } from '../lib/geo'

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
}

export async function createBuyerRequestUseCase(data: CreateRequestInput) {
  const { items, ...requestData } = data

  // Check if buyer has any active order in progress
  const activeOrder = await prisma.order.findFirst({
    where: {
      buyerCompanyId: data.buyerCompanyId,
      status: { in: ['CREATED', 'CONFIRMED', 'IN_DELIVERY'] }
    }
  })

  if (activeOrder) {
    throw new AppError('Você possui um pedido em andamento. Aguarde a conclusão da entrega para realizar um novo pedido.')
  }

  // Validate address belongs to company
  const address = await prisma.address.findFirst({
    where: { id: data.addressId, companyId: data.buyerCompanyId },
  })
  if (!address) throw new NotFoundError('Endereço')

  // Fetch offer window setting (default 5 minutes)
  const windowSetting = await prisma.systemSetting.findUnique({
    where: { key: 'proposal_window_minutes' }
  })
  const windowMinutes = windowSetting ? parseInt(windowSetting.value, 10) : 5

  const calculatedExpiresAt = new Date(Date.now() + windowMinutes * 60 * 1000)

  const request = await prisma.buyerRequest.create({
    data: {
      ...requestData,
      deadline: new Date(data.deadline),
      expiresAt: calculatedExpiresAt,
      status: 'OPEN',
      items: {
        create: items.map(item => ({
          productId: item.productId,
          quantity: item.quantity,
        }))
      }
    },
    include: {
      items: { include: { product: true } },
      address: true,
    },
  })

  // === AUTO-BIDDING LOGIC ===
  try {
    // 1. Find all suppliers in the same city/state
    const coverages = await prisma.supplierCoverage.findMany({
      where: { city: address.city, state: address.state },
      select: { supplierCompanyId: true }
    })
    const coverageCompanyIds = coverages.map(c => c.supplierCompanyId)

    if (coverageCompanyIds.length > 0) {
      // 2. Fetch those suppliers' addresses to calculate exact distance
      const supplierAddresses = await prisma.address.findMany({
        where: { companyId: { in: coverageCompanyIds } }
      })

      // 3. For each supplier, check if they can fulfill the whole request via auto-bidding
      for (const supplierCompanyId of coverageCompanyIds) {
        // Get supplier address (prefer main)
        const sAddr = supplierAddresses.find(a => a.companyId === supplierCompanyId && a.isMain) 
          || supplierAddresses.find(a => a.companyId === supplierCompanyId)
        
        if (!sAddr || sAddr.latitude == null || sAddr.longitude == null || address.latitude == null || address.longitude == null) continue

        // Fetch their catalog for the requested products
        const requestedProductIds = items.map(i => i.productId)
        const supplierCatalog = await prisma.supplierProduct.findMany({
          where: {
            supplierCompanyId,
            productId: { in: requestedProductIds },
            active: true,
            biddingMode: { in: ['AUTO_ONLY', 'BOTH'] }
          }
        })

        // If supplier doesn't have auto-bidding setup for ALL requested products, skip
        if (supplierCatalog.length !== requestedProductIds.length) continue

        let canFulfill = true
        const proposalItemsData: any[] = []

        for (const reqItem of request.items) {
          const cat = supplierCatalog.find(c => c.productId === reqItem.productId)
          if (!cat || cat.defaultPrice === null) { 
            canFulfill = false; 
            break; 
          }

          proposalItemsData.push({
            buyerRequestItemId: reqItem.id,
            unitPrice: cat.defaultPrice
          })
        }

        if (canFulfill) {
          // Create SupplierProposal
          await prisma.supplierProposal.create({
            data: {
              buyerRequestId: request.id,
              supplierCompanyId,
              freightPrice: 0,
              deliveryDeadline: new Date(data.deadline), // Auto bid uses buyer's deadline
              status: 'SUBMITTED',
              items: {
                create: proposalItemsData
              }
            }
          })
        }
      }
    }
  } catch (err) {
    console.error('Error in auto-bidding logic', err)
  }
  // === END AUTO-BIDDING LOGIC ===

  // WebSocket Notification for Suppliers (regional + fallback to all active suppliers)
  try {
    const suppliersInRegion = await prisma.supplierCoverage.findMany({
      where: { city: address.city, state: address.state },
      select: { supplierCompanyId: true }
    })

    const companyIds = suppliersInRegion.map(s => s.supplierCompanyId)
    
    // Find supplier users by region OR all active supplier users as fallback
    const usersToNotify = await prisma.user.findMany({
      where: companyIds.length > 0 
        ? { companyId: { in: companyIds }, role: 'SUPPLIER' }
        : { role: 'SUPPLIER' },
      select: { id: true }
    })

    usersToNotify.forEach(user => {
      wsManager.notifyUser(user.id, 'NEW_OPPORTUNITY', { requestId: request.id })
    })
  } catch (err) {
    console.error('Error sending WS notification to suppliers', err)
  }

  return request
}

export async function listBuyerRequestsUseCase(companyId: string, page: number, limit: number) {
  const [data, total] = await Promise.all([
    prisma.buyerRequest.findMany({
      where: { buyerCompanyId: companyId },
      include: {
        items: { include: { product: true } },
        address: true,
        order: {
          include: {
            rating: true
          }
        },
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

export async function getBuyerRequestUseCase(id: string, companyId?: string, supplierCompanyId?: string) {
  const request = await prisma.buyerRequest.findUnique({
    where: { id },
    include: {
      items: { include: { product: true } },
      address: true,
      buyerCompany: { select: { id: true, name: true, cnpj: true } },
      proposals: {
        where: supplierCompanyId ? { supplierCompanyId } : undefined,
        include: {
          items: {
            include: {
              buyerRequestItem: {
                include: {
                  product: true
                }
              }
            }
          },
          supplierCompany: { 
            select: { 
              id: true, 
              name: true, 
              cnpj: true,
              ratingsReceived: { select: { stars: true } },
              addresses: true
            } 
          },
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

  // Calculate distance if supplier context is provided (Supplier looking at opportunity)
  let distanceKm: number | null = null
  if (supplierCompanyId && request.address?.latitude && request.address?.longitude) {
    const supplierAddress = await prisma.address.findFirst({
      where: { companyId: supplierCompanyId, isMain: true },
    }) || await prisma.address.findFirst({
      where: { companyId: supplierCompanyId },
    })

    if (supplierAddress?.latitude && supplierAddress?.longitude) {
      distanceKm = calculateDistance(
        supplierAddress.latitude,
        supplierAddress.longitude,
        request.address.latitude,
        request.address.longitude
      )
    }
  }

  // Calculate lowest proposals if supplier looking at opportunity and has submitted a proposal
  let lowestMarketSummary: any = null
  if (supplierCompanyId) {
    const allProposals = await prisma.supplierProposal.findMany({
      where: {
        buyerRequestId: id,
        status: { notIn: ['WITHDRAWN', 'REJECTED'] }
      },
      include: {
        items: {
          include: {
            buyerRequestItem: {
              include: { product: true }
            }
          }
        }
      }
    })

    const hasMyProposal = allProposals.some(p => p.supplierCompanyId === supplierCompanyId)

    if (hasMyProposal && allProposals.length > 0) {
      // Find lowest total price proposal
      let lowestTotal = Infinity
      let lowestProp: typeof allProposals[0] | null = null

      allProposals.forEach(prop => {
        const itemsSum = prop.items.reduce((sum, item) => sum + (item.unitPrice * item.buyerRequestItem.quantity), 0)
        const grandTotal = itemsSum + prop.freightPrice
        if (grandTotal < lowestTotal) {
          lowestTotal = grandTotal
          lowestProp = prop
        }
      })

      // Calculate my proposal's total price
      const myProp = allProposals.find(p => p.supplierCompanyId === supplierCompanyId)
      const myItemsSum = myProp ? myProp.items.reduce((sum, item) => sum + (item.unitPrice * item.buyerRequestItem.quantity), 0) : 0
      const myTotal = myProp ? myItemsSum + myProp.freightPrice : Infinity

      // I am leading ONLY if my proposal total is <= lowestTotal
      const isMyProposal = myTotal <= lowestTotal

      if (lowestProp) {
        lowestMarketSummary = {
          totalPrice: lowestTotal,
          myTotal: myTotal < Infinity ? myTotal : null,
          freightPrice: (lowestProp as any).freightPrice,
          isMyProposal,
          items: (lowestProp as any).items.map((item: any) => ({
            productId: item.buyerRequestItem.productId,
            productName: item.buyerRequestItem.product.name,
            quantity: item.buyerRequestItem.quantity,
            unitPrice: item.unitPrice,
            subtotal: item.unitPrice * item.buyerRequestItem.quantity
          }))
        }
      }
    }
  }

  // Calculate distance for each proposal if Buyer is looking at their request
  const proposalsWithDistance = request.proposals.map(proposal => {
    let propDistanceKm: number | null = null
    const supplierAddress = proposal.supplierCompany.addresses?.[0]
    
    if (supplierAddress?.latitude && supplierAddress?.longitude && request.address?.latitude && request.address?.longitude) {
      propDistanceKm = calculateDistance(
        supplierAddress.latitude,
        supplierAddress.longitude,
        request.address.latitude,
        request.address.longitude
      )
    }
    return { ...proposal, distanceKm: propDistanceKm }
  })

  return { ...request, distanceKm, proposals: proposalsWithDistance, lowestMarketSummary }
}

export async function listOpportunitiesUseCase(
  supplierCompanyId: string,
  page: number,
  limit: number,
  showApplied = false,
) {
  const coverages = await prisma.supplierCoverage.findMany({
    where: { supplierCompanyId },
  })

  if (coverages.length === 0) return { data: [], total: 0, page, limit, pages: 0 }

  const stateCities = coverages.map((c) => ({ city: c.city, state: c.state }))
  const orConditions = stateCities.map((sc) => ({
    address: { city: sc.city, state: sc.state },
  }))

  // Get supplier address for distance calculation
  const supplierAddress = await prisma.address.findFirst({
    where: { companyId: supplierCompanyId, isMain: true },
  }) || await prisma.address.findFirst({
    where: { companyId: supplierCompanyId },
  })

  const [data, total] = await Promise.all([
    prisma.buyerRequest.findMany({
      where: {
        status: 'OPEN',
        expiresAt: { gt: new Date() },
        OR: orConditions,
      },
      include: {
        items: { include: { product: true } },
        address: true,
        buyerCompany: { select: { id: true, name: true } },
        _count: { select: { proposals: true } },
        proposals: {
          where: { supplierCompanyId },
          select: { id: true, status: true }
        }
      },
      orderBy: { createdAt: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    }),
    prisma.buyerRequest.count({
      where: {
        status: 'OPEN',
        expiresAt: { gt: new Date() },
        OR: orConditions,
      },
    }),
  ])

  // Calculate distances
  const requestsWithDistance = data.map(req => {
    let distanceKm: number | null = null
    if (
      supplierAddress?.latitude && 
      supplierAddress?.longitude && 
      req.address?.latitude && 
      req.address?.longitude
    ) {
      distanceKm = calculateDistance(
        supplierAddress.latitude,
        supplierAddress.longitude,
        req.address.latitude,
        req.address.longitude
      )
    }
    return { ...req, distanceKm }
  })

  return { data: requestsWithDistance, total, page, limit, pages: Math.ceil(total / limit) }
}

export async function cancelBuyerRequestUseCase(id: string, companyId: string) {
  const request = await prisma.buyerRequest.findUnique({
    where: { id },
    include: { 
      proposals: { select: { supplierCompanyId: true } },
      address: { select: { city: true, state: true } }
    },
  })

  if (!request) throw new NotFoundError('Solicitação')
  if (request.buyerCompanyId !== companyId) throw new ForbiddenError()

  const updatedRequest = await prisma.buyerRequest.update({
    where: { id },
    data: { status: 'CANCELLED' },
  })

  // WebSocket Notification for interested suppliers
  try {
    const suppliersToNotify = new Set<string>()
    
    // Notify those who sent proposals
    request.proposals.forEach(p => suppliersToNotify.add(p.supplierCompanyId))
    
    if (suppliersToNotify.size > 0) {
      const users = await prisma.user.findMany({
        where: { companyId: { in: Array.from(suppliersToNotify) }, role: 'SUPPLIER' },
        select: { id: true }
      })

      users.forEach(user => {
        wsManager.notifyUser(user.id, 'OPPORTUNITY_CANCELLED', { requestId: id })
      })
    }
  } catch (err) {
    console.error('Error sending cancellation WS notification', err)
  }

  return updatedRequest
}
