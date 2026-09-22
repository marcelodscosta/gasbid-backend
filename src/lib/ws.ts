export const clients = new Map<string, any[]>()

export const wsManager = {
  addClient(userId: string, socket: any) {
    if (!clients.has(userId)) {
      clients.set(userId, [])
    }
    clients.get(userId)!.push(socket)

    socket.on('close', () => {
      this.removeClient(userId, socket)
    })
  },

  removeClient(userId: string, socket: any) {
    const userClients = clients.get(userId)
    if (userClients) {
      const filtered = userClients.filter(c => c !== socket)
      if (filtered.length === 0) {
        clients.delete(userId)
      } else {
        clients.set(userId, filtered)
      }
    }
  },

  notifyUser(userId: string, event: string, payload?: any) {
    const userClients = clients.get(userId)
    if (userClients) {
      const message = JSON.stringify({ event, payload })
      userClients.forEach(socket => {
        if (socket.readyState === 1 /* OPEN */) {
          socket.send(message)
        }
      })
    }
  }
}
