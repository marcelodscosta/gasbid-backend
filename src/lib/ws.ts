import { prisma } from './prisma'

type Socket = {
  readyState: number
  send: (data: string) => void
  on: (event: string, cb: (...args: any[]) => void) => void
  ping?: () => void
  terminate?: () => void
  isAlive?: boolean
}

/**
 * Gerenciador de WebSocket com salas.
 * Salas usadas: `user:{id}`, `company:{id}`, `region:{cidade|UF}`, `request:{id}`.
 *
 * Observação: estado em memória (1 instância). Para escalar horizontalmente,
 * substituir `broadcast` por Redis pub/sub mantendo a mesma interface.
 */
class WsManager {
  private rooms = new Map<string, Set<Socket>>()
  private socketRooms = new Map<Socket, Set<string>>()
  private heartbeat?: NodeJS.Timeout

  join(socket: Socket, room: string) {
    if (!this.rooms.has(room)) this.rooms.set(room, new Set())
    this.rooms.get(room)!.add(socket)
    if (!this.socketRooms.has(socket)) this.socketRooms.set(socket, new Set())
    this.socketRooms.get(socket)!.add(room)
  }

  leave(socket: Socket, room: string) {
    this.rooms.get(room)?.delete(socket)
    if (this.rooms.get(room)?.size === 0) this.rooms.delete(room)
    this.socketRooms.get(socket)?.delete(room)
  }

  leaveAll(socket: Socket) {
    for (const room of this.socketRooms.get(socket) ?? []) this.leave(socket, room)
    this.socketRooms.delete(socket)
  }

  /** Registra o socket do usuário nas salas padrão. */
  addClient(userId: string, socket: Socket, opts: { companyId?: string | null; region?: string | null } = {}) {
    socket.isAlive = true
    socket.on('pong', () => { socket.isAlive = true })
    socket.on('close', () => this.leaveAll(socket))
    this.join(socket, `user:${userId}`)
    if (opts.companyId) this.join(socket, `company:${opts.companyId}`)
    if (opts.region) this.join(socket, `region:${opts.region}`)
    this.startHeartbeat()
  }

  broadcast(room: string, event: string, payload?: unknown) {
    const sockets = this.rooms.get(room)
    if (!sockets) return
    const message = JSON.stringify({ event, payload })
    for (const s of sockets) if (s.readyState === 1) s.send(message)
  }

  notifyUser(userId: string, event: string, payload?: unknown) {
    this.broadcast(`user:${userId}`, event, payload)
  }

  notifyCompany(companyId: string, event: string, payload?: unknown) {
    this.broadcast(`company:${companyId}`, event, payload)
  }

  notifyCompanies(companyIds: string[], event: string, payload?: unknown) {
    for (const id of new Set(companyIds)) this.notifyCompany(id, event, payload)
  }

  stats() {
    return { sockets: this.socketRooms.size, rooms: this.rooms.size }
  }

  private startHeartbeat() {
    if (this.heartbeat) return
    this.heartbeat = setInterval(() => {
      for (const s of this.socketRooms.keys()) {
        if (s.isAlive === false) { s.terminate?.(); this.leaveAll(s); continue }
        s.isAlive = false
        try { s.ping?.() } catch { /* ignore */ }
      }
    }, 30_000)
    this.heartbeat.unref?.()
  }
}

export const wsManager = new WsManager()

export function regionKey(city: string, state: string) {
  return `${city.trim().toLowerCase()}|${state.trim().toUpperCase()}`
}

/** Região principal de uma empresa (pelo endereço principal). */
export async function companyRegion(companyId: string | null | undefined) {
  if (!companyId) return null
  const addr = await prisma.address.findFirst({
    where: { companyId },
    orderBy: { isMain: 'desc' },
    select: { city: true, state: true },
  })
  return addr ? regionKey(addr.city, addr.state) : null
}
