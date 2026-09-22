import { prisma } from '../lib/prisma'

function getDistanceInKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371
  const dLat = (lat2 - lat1) * (Math.PI / 180)
  const dLon = (lon2 - lon1) * (Math.PI / 180)
  const a = 
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * (Math.PI / 180)) * Math.cos(lat2 * (Math.PI / 180)) * 
    Math.sin(dLon / 2) * Math.sin(dLon / 2)
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a))
  return R * c
}

export async function getSupplierStatsUseCase(supplierCompanyId: string, month: string, year: string) {
  const startDate = new Date(Number(year), Number(month) - 1, 1)
  const endDate = new Date(Number(year), Number(month), 1)

  // 1. Propostas feitas no mês
  const proposals = await prisma.supplierProposal.findMany({
    where: {
      supplierCompanyId,
      createdAt: { gte: startDate, lt: endDate }
    },
    include: {
      items: { include: { buyerRequestItem: true } },
      buyerRequest: { 
        include: { 
          address: true,
          order: { include: { proposal: { include: { items: true } } } }
        } 
      }
    }
  })

  // 2. Pedidos ganhos no mês
  const wonOrders = await prisma.order.findMany({
    where: {
      supplierCompanyId,
      createdAt: { gte: startDate, lt: endDate },
      status: { notIn: ['CANCELLED'] }
    }
  })

  const supplier = await prisma.company.findUnique({
    where: { id: supplierCompanyId },
    include: { addresses: true }
  })

  const mainAddress = supplier?.addresses.find(a => a.isMain) || supplier?.addresses[0]

  let totalFaturado = wonOrders.reduce((acc, order) => acc + order.totalPrice, 0)
  let leiloesParticipados = proposals.length
  let leiloesGanhos = wonOrders.length
  let taxaConversao = leiloesParticipados > 0 ? (leiloesGanhos / leiloesParticipados) * 100 : 0
  let ticketMedio = leiloesGanhos > 0 ? totalFaturado / leiloesGanhos : 0

  let perdas = 0
  let somaDiferencaPreco = 0

  let distData = {
    ate5km: { participados: 0, ganhos: 0 },
    de5a10km: { participados: 0, ganhos: 0 },
    mais10km: { participados: 0, ganhos: 0 }
  }

  proposals.forEach(prop => {
    // Distância
    let dist = -1
    if (mainAddress?.latitude && mainAddress?.longitude && prop.buyerRequest.address?.latitude && prop.buyerRequest.address?.longitude) {
      dist = getDistanceInKm(
        Number(mainAddress.latitude), Number(mainAddress.longitude),
        Number(prop.buyerRequest.address.latitude), Number(prop.buyerRequest.address.longitude)
      )
    }

    const wonThis = wonOrders.some(o => o.buyerRequestId === prop.buyerRequestId)

    if (dist >= 0) {
      let bucket = ''
      if (dist <= 5) bucket = 'ate5km'
      else if (dist <= 10) bucket = 'de5a10km'
      else bucket = 'mais10km'

      distData[bucket as keyof typeof distData].participados++
      if (wonThis) distData[bucket as keyof typeof distData].ganhos++
    }

    // Perda / Diferença de Preço
    if (!wonThis) {
      const winningOrder = (prop.buyerRequest as any).order
      if (winningOrder && winningOrder.status !== 'CANCELLED') {
        // Calcular o valor total da nossa proposta
        const myTotal = prop.items.reduce((acc, i) => acc + (i.unitPrice * i.buyerRequestItem.quantity), 0) + prop.freightPrice
        const diff = myTotal - winningOrder.totalPrice
        if (diff > 0) {
          perdas++
          somaDiferencaPreco += diff
        }
      }
    }
  })

  let diferencaMediaPreco = perdas > 0 ? somaDiferencaPreco / perdas : 0

  return {
    overview: {
      totalFaturado,
      leiloesParticipados,
      leiloesGanhos,
      taxaConversao,
      ticketMedio
    },
    competitiveness: {
      perdasAnalisadas: perdas,
      diferencaMediaPreco,
      distanceAnalysis: [
        { label: 'Até 5km', ...distData.ate5km },
        { label: '5 a 10km', ...distData.de5a10km },
        { label: 'Mais de 10km', ...distData.mais10km }
      ]
    }
  }
}
