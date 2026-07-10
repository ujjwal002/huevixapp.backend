import http from 'node:http';
import app from './app.js';
import { config } from './config/env.js';
import { prisma } from './db/prisma.js';
import { initRealtime } from './realtime/socket.js';

import { closeRedis } from './db/redis.js';

import { beginDraining } from './realtime/lifecycle.js';
import { activeCallCount, drainAllRooms } from './realtime/rooms.js';

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

// Graceful shutdown (Option A): stop taking NEW calls immediately, let
// in-progress calls finish for up to DRAIN_GRACE_MS (exit early once they all
// do), then cleanly finalize+bill anything still live and exit. A single
// instance can't hold a deploy open for a 40-minute call, so this makes the
// common case (calls near a deploy) graceful and guarantees correct billing on
// shutdown — it does not make deploys fully transparent (that's multi-instance).
const DRAIN_GRACE_MS = 30_000;
const DRAIN_POLL_MS = 500;

let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return; // ignore a second signal during shutdown
  shuttingDown = true;
  console.log(`\n${signal} received, draining...`);

  // 1. Stop STARTING new calls/matches right away. Existing calls keep going.
  beginDraining();

  // 2. Absolute cap on the whole shutdown so a stuck socket/request can't wedge
  //    the process: force-exit after the grace window plus a buffer.
  const forceExit = setTimeout(() => {
    console.error('Graceful shutdown timed out; forcing exit.');
    process.exit(1);
  }, DRAIN_GRACE_MS + 15_000);
  if (typeof forceExit.unref === 'function') forceExit.unref();

  // 3. Give in-progress calls up to DRAIN_GRACE_MS to end on their own.
  const deadline = Date.now() + DRAIN_GRACE_MS;
  while (activeCallCount() > 0 && Date.now() < deadline) {
    console.log(`[shutdown] waiting for ${activeCallCount()} active call(s) to finish...`);
    await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
  }

  // 4. Cleanly end whatever is still live (bills elapsed talk time, once each).
  const remaining = activeCallCount();
  if (remaining > 0) {
    console.log(`[shutdown] grace elapsed; ending ${remaining} remaining call(s) cleanly`);
    await drainAllRooms(io, { reason: 'server_restart' }).catch((e) =>
      console.error('[shutdown] drainAllRooms failed:', e.message)
    );
  }

  // 5. Close realtime + HTTP, disconnect DB/Redis, exit.
  io.close();
  server.close(async () => {
    try {
      await prisma.$disconnect();
      await closeRedis();
    } finally {
      clearTimeout(forceExit);
      process.exit(0);
    }
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
