import { prisma } from '../lib/prisma'
import { wsManager } from '../lib/ws'
import { ForbiddenError, NotFoundError, AppError } from '../errors/app-error'

/** Posições mais antigas que isso são tratadas como offline. */
export const LOCATION_STALE_MS = 2 * 60 * 1000
/** Cache dos compradores com entrega em andamento, para não consultar o banco a cada ping. */
const BUYERS_CACHE_TTL_MS = 15_000
const buyersCache = new Map<string, { at: number; ids: string[] }>()

export interface LocationInput {
  latitude: number
  longitude: number
  heading?: number | null
  speed?: number | null
}

async function activeBuyerIds(supplierCompanyId: string): Promise<string[]> {
  const hit = buyersCache.get(supplierCompanyId)
  if (hit && Date.now() - hit.at < BUYERS_CACHE_TTL_MS) return hit.ids
  const orders = await prisma.order.findMany({
    where: { supplierCompanyId, status: 'IN_DELIVERY' },
    select: { buyerCompanyId: true },
  })
  const ids = Array.from(new Set(orders.map(o => o.buyerCompanyId)))
  buyersCache.set(supplierCompanyId, { at: Date.now(), ids })
  return ids
}

/** Descarta o cache de compradores (chamado quando um pedido muda de status). */
export function invalidateTrackingCache(supplierCompanyId: string) {
  buyersCache.delete(supplierCompanyId)
}

export async function setTrackingEnabledUseCase(companyId: string, enabled: boolean) {
  const company = await prisma.company.update({
    where: { id: companyId },
    data: { trackingEnabled: enabled },
    select: { id: true, trackingEnabled: true },
  })
  if (!enabled) await goOfflineUseCase(companyId)
  return company
}

export async function updateLocationUseCase(userId: string, companyId: string, loc: LocationInput) {
  const company = await prisma.company.findUnique({
    where: { id: companyId },
    select: { trackingEnabled: true },
  })
  if (!company) throw new NotFoundError('Empresa')
  if (!company.trackingEnabled) throw new ForbiddenError('Rastreamento desativado para esta empresa')

  // Só registra posição enquanto há entrega em andamento (evita escrita e retenção desnecessárias)
  const buyersNow = await activeBuyerIds(companyId)
  if (buyersNow.length === 0) {
    throw new AppError('Nenhum pedido em entrega para compartilhar localização')
  }

  const data = {
    userId,
    latitude: loc.latitude,
    longitude: loc.longitude,
    heading: loc.heading ?? null,
    speed: loc.speed ?? null,
    isOnline: true,
  }
  const saved = await prisma.supplierLiveLocation.upsert({
    where: { companyId },
    create: { companyId, ...data },
    update: data,
  })

  const buyers = buyersNow
  if (buyers.length > 0) {
    wsManager.notifyCompanies(buyers, 'SUPPLIER_LOCATION', {
      supplierCompanyId: companyId,
      latitude: saved.latitude,
      longitude: saved.longitude,
      heading: saved.heading,
      speed: saved.speed,
      updatedAt: saved.updatedAt,
    })
  }
  return { ok: true, updatedAt: saved.updatedAt }
}

export async function goOfflineUseCase(companyId: string) {
  await prisma.supplierLiveLocation.updateMany({
    where: { companyId },
    data: { isOnline: false },
  })
  const buyers = await activeBuyerIds(companyId)
  wsManager.notifyCompanies(buyers, 'SUPPLIER_OFFLINE', { supplierCompanyId: companyId })
  buyersCache.delete(companyId)
  return { ok: true }
}

/** Posição do fornecedor para o comprador (ou o próprio fornecedor) de um pedido em entrega. */
export async function getOrderTrackingUseCase(orderId: string, companyId: string, role?: string) {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { id: true, status: true, buyerCompanyId: true, supplierCompanyId: true },
  })
  if (!order) throw new NotFoundError('Pedido')
  if (role !== 'ADMIN' && order.buyerCompanyId !== companyId && order.supplierCompanyId !== companyId) {
    throw new ForbiddenError()
  }
  if (order.status !== 'IN_DELIVERY') {
    throw new AppError('O rastreamento só fica disponível enquanto o pedido está em entrega')
  }

  const supplier = await prisma.company.findUnique({
    where: { id: order.supplierCompanyId },
    select: { trackingEnabled: true, liveLocation: true },
  })
  const loc = supplier?.liveLocation
  const fresh = !!loc && loc.isOnline && Date.now() - loc.updatedAt.getTime() < LOCATION_STALE_MS

  return {
    orderId: order.id,
    trackingEnabled: !!supplier?.trackingEnabled,
    online: !!supplier?.trackingEnabled && fresh,
    location: supplier?.trackingEnabled && loc
      ? {
          latitude: loc.latitude,
          longitude: loc.longitude,
          heading: loc.heading,
          speed: loc.speed,
          updatedAt: loc.updatedAt,
        }
      : null,
  }
}
