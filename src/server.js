import http from 'node:http';
import app from './app.js';
import { config } from './config/env.js';
import { prisma } from './db/prisma.js';
import { initRealtime } from './realtime/socket.js';

// Wrap the Express app in an explicit HTTP server so the realtime (Socket.IO)
// layer can share the same port. Calling app.listen() directly would leave no
// server handle to attach sockets to.
const server = http.createServer(app);
const io = initRealtime(server);

server.listen(config.port, () => {
  console.log(`LingoShorts API running on http://localhost:${config.port}${config.apiPrefix}`);
  console.log('Socket.IO realtime ready (practice calling)');
  console.log(`Mock external services: ${config.mockExternal}`);
});

async function shutdown(signal) {
  console.log(`\n${signal} received, shutting down...`);
  // Stop accepting new connections, then disconnect the DB and exit. If
  // something hangs (a stuck in-flight request, a slow socket), force-exit
  // after a grace period so the process can't get wedged on shutdown.
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit.');
    process.exit(1);
  }, 10_000);
  if (typeof forceExit.unref === 'function') forceExit.unref();

  // Close the realtime layer first (disconnects sockets), then the HTTP server.
  io.close();
  server.close(async () => {
    try {
      await prisma.$disconnect();
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
