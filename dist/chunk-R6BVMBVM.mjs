// src/lib/ws.ts
var clients = /* @__PURE__ */ new Map();
var wsManager = {
  addClient(userId, socket) {
    if (!clients.has(userId)) {
      clients.set(userId, []);
    }
    clients.get(userId).push(socket);
    socket.on("close", () => {
      this.removeClient(userId, socket);
    });
  },
  removeClient(userId, socket) {
    const userClients = clients.get(userId);
    if (userClients) {
      const filtered = userClients.filter((c) => c !== socket);
      if (filtered.length === 0) {
        clients.delete(userId);
      } else {
        clients.set(userId, filtered);
      }
    }
  },
  notifyUser(userId, event, payload) {
    const userClients = clients.get(userId);
    if (userClients) {
      const message = JSON.stringify({ event, payload });
      userClients.forEach((socket) => {
        if (socket.readyState === 1) {
          socket.send(message);
        }
      });
    }
  }
};

export {
  clients,
  wsManager
};
