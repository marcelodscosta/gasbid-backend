import Expo, { ExpoPushMessage } from 'expo-server-sdk'
import { prisma } from '../lib/prisma'

const expo = new Expo()

type PushData = Record<string, any>

interface Target {
  userIds?: string[]
  companyIds?: string[]
  role?: 'BUYER' | 'SUPPLIER' | 'ADMIN'
}

/**
 * Envia push em lote: 1 query para todos os tokens + envio em chunks.
 * Executa fora do caminho da requisição (fire-and-forget) para não atrasar a API.
 */
function dispatch(target: Target, title: string, body: string, data?: PushData) {
  setImmediate(() => {
    sendNow(target, title, body, data).catch(err => console.error('[PUSH] dispatch error:', err))
  })
}

async function sendNow(target: Target, title: string, body: string, data?: PushData) {
  const userFilter: any = {}
  if (target.userIds?.length) userFilter.id = { in: target.userIds }
  if (target.companyIds?.length) userFilter.companyId = { in: target.companyIds }
  if (target.role) userFilter.role = target.role
  if (!target.userIds?.length && !target.companyIds?.length) return

  const tokens = await prisma.pushToken.findMany({
    where: { active: true, user: userFilter },
    select: { token: true },
  })

  const messages: ExpoPushMessage[] = tokens
    .filter(t => Expo.isExpoPushToken(t.token))
    .map(t => ({
      to: t.token,
      sound: 'default' as const,
      title,
      body,
      data: data || {},
      priority: 'high' as const,
      channelId: 'default',
    }))
  if (messages.length === 0) return

  const invalid: string[] = []
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk)
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          const to = chunk[i].to
          invalid.push(typeof to === 'string' ? to : to[0])
        }
      })
    } catch (err) {
      console.error('[PUSH] Chunk send error:', err)
    }
  }

  if (invalid.length) {
    await prisma.pushToken.updateMany({ where: { token: { in: invalid } }, data: { active: false } })
  }
}

export function sendPushToUser(userId: string, title: string, body: string, data?: PushData) {
  dispatch({ userIds: [userId] }, title, body, data)
}

export function sendPushToCompany(companyId: string, title: string, body: string, data?: PushData) {
  dispatch({ companyIds: [companyId] }, title, body, data)
}

export function sendPushToCompanies(companyIds: string[], title: string, body: string, data?: PushData) {
  dispatch({ companyIds }, title, body, data)
}

export function sendPushToSuppliers(companyIds: string[], title: string, body: string, data?: PushData) {
  dispatch({ companyIds, role: 'SUPPLIER' }, title, body, data)
}

/** Exposto para testes. */
export const __pushInternals = { sendNow }
