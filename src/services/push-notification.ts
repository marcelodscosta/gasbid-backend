import Expo, { ExpoPushMessage, ExpoPushTicket } from 'expo-server-sdk'
import { prisma } from '../lib/prisma'

const expo = new Expo()

/**
 * Envia push notification para um usuário específico (todos os dispositivos dele)
 */
export async function sendPushToUser(
  userId: string,
  title: string,
  body: string,
  data?: Record<string, any>
) {
  try {
    const tokens = await prisma.pushToken.findMany({
      where: { userId, active: true },
    })

    if (tokens.length === 0) return

    const messages: ExpoPushMessage[] = tokens
      .filter((t: { token: string }) => Expo.isExpoPushToken(t.token))
      .map((t: { token: string }) => ({
        to: t.token,
        sound: 'default' as const,
        title,
        body,
        data: data || {},
        priority: 'high' as const,
        channelId: 'default',
      }))

    if (messages.length === 0) return

    const chunks = expo.chunkPushNotifications(messages)
    for (const chunk of chunks) {
      try {
        const tickets: ExpoPushTicket[] = await expo.sendPushNotificationsAsync(chunk)
        
        // Desativar tokens inválidos
        for (let i = 0; i < tickets.length; i++) {
          const ticket = tickets[i]
          if (ticket.status === 'error') {
            if (ticket.details?.error === 'DeviceNotRegistered') {
              const failedMessage = chunk[i]
              const tokenStr = typeof failedMessage.to === 'string' ? failedMessage.to : failedMessage.to[0]
              await prisma.pushToken.updateMany({
                where: { token: tokenStr },
                data: { active: false },
              })
              console.log(`[PUSH] Deactivated invalid token: ${tokenStr.substring(0, 20)}...`)
            }
            console.error(`[PUSH] Error sending to user ${userId}:`, ticket.message)
          }
        }
      } catch (err) {
        console.error('[PUSH] Chunk send error:', err)
      }
    }
  } catch (err) {
    console.error('[PUSH] sendPushToUser error:', err)
  }
}

/**
 * Envia push notification para todos os usuários de uma empresa
 */
export async function sendPushToCompany(
  companyId: string,
  title: string,
  body: string,
  data?: Record<string, any>
) {
  try {
    const users = await prisma.user.findMany({
      where: { companyId },
      select: { id: true },
    })

    await Promise.allSettled(
      users.map(u => sendPushToUser(u.id, title, body, data))
    )
  } catch (err) {
    console.error('[PUSH] sendPushToCompany error:', err)
  }
}

/**
 * Envia push notification para múltiplas empresas
 */
export async function sendPushToCompanies(
  companyIds: string[],
  title: string,
  body: string,
  data?: Record<string, any>
) {
  await Promise.allSettled(
    companyIds.map(id => sendPushToCompany(id, title, body, data))
  )
}

/**
 * Envia push para todos os usuários SUPPLIER de empresas específicas
 */
export async function sendPushToSuppliers(
  companyIds: string[],
  title: string,
  body: string,
  data?: Record<string, any>
) {
  try {
    const users = await prisma.user.findMany({
      where: { companyId: { in: companyIds }, role: 'SUPPLIER' },
      select: { id: true },
    })

    await Promise.allSettled(
      users.map(u => sendPushToUser(u.id, title, body, data))
    )
  } catch (err) {
    console.error('[PUSH] sendPushToSuppliers error:', err)
  }
}
