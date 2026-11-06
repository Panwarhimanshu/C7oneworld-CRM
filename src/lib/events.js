'use strict';

// Server-Sent Events hub. Events carry identifiers and short labels only; clients
// re-fetch details through the authorised REST endpoints.
function createEventHub() {
  const clients = new Set();

  const heartbeat = setInterval(() => {
    for (const c of clients) c.res.write(': ping\n\n');
  }, 25_000);
  heartbeat.unref();

  function drop(c) {
    c.res.end();
    clients.delete(c);
  }

  return {
    // isAlive: session still valid; can(permission): current permission check.
    subscribe(req, res, { userId, isAlive, can }) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write('retry: 5000\n\n');
      const client = { res, userId, isAlive, can };
      clients.add(client);
      req.on('close', () => clients.delete(client));
    },

    // Deliver to everyone holding `permission`, or only to `userId`.
    publish(type, payload, { permission, userId } = {}) {
      const frame = `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
      for (const c of clients) {
        if (userId && c.userId !== userId) continue;
        // Re-check on every event so revoked sessions and permissions stop receiving data.
        if (!c.isAlive()) {
          drop(c);
          continue;
        }
        if (permission && !c.can(permission)) continue;
        c.res.write(frame);
      }
    },

    disconnectUser(userId) {
      for (const c of clients) if (c.userId === userId) drop(c);
    },

    close() {
      clearInterval(heartbeat);
      for (const c of clients) c.res.end();
      clients.clear();
    },
  };
}

module.exports = { createEventHub };
