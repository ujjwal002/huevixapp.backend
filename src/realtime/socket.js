import { Server } from 'socket.io';
import { verifyAccessToken } from '../utils/jwt.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { addPresence, removePresence, onlineCount } from './presence.js';
import { registerMatchmaking, leaveQueue } from './matchmaking.js';
import { registerTutorCalls, cleanupTutorInvites, deliverPendingInvites } from './tutorCalls.js';
import { registerSignaling } from './signaling.js';
import { handleDisconnect, startBillingWatchdog } from './rooms.js';

import { getPubSub, redisEnabled } from '../db/redis.js';

let io = null;

export function getIo() {
  return io;
}

// Attach a Socket.IO server to the existing HTTP server (same port as the REST
// API). Every connection is authenticated on the handshake with the same JWT
// access token the REST API uses — no separate auth system.
export function initRealtime(httpServer) {
  io = new Server(httpServer, {
    path: '/socket.io',
    // Mirror the REST CORS policy: allow no-origin (native mobile clients have
    // no Origin header) and the configured browser origins; reject the rest.
    cors: {
      origin: (origin, cb) => {
        if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
        cb(new Error('Not allowed by CORS'));
      },
      credentials: true,
    },
  });

  // Multi-instance mode: attach the Redis adapter so socket emits/broadcasts
  // (io.to(socketId).emit(), room broadcasts) reach clients connected to OTHER
  // instances. With no REDIS_URL this is skipped and Socket.IO runs purely
  // in-process — identical to the current single-instance behavior.
  //
  // NOTE: the adapter only fixes cross-instance MESSAGE DELIVERY. The realtime
  // layer's shared STATE (matchmaking queue, presence, rooms, invites) is moved
  // to Redis in later stages; until those land, do NOT run more than one
  // instance — matchmaking would be split across processes.
  if (redisEnabled()) {
    const { pub, sub } = getPubSub();
    io.adapter(createAdapter(pub, sub));
    console.log('[rt] Socket.IO Redis adapter attached (multi-instance delivery)');
  } else {
    console.log('[rt] single-instance mode (no REDIS_URL); realtime state is in-process');
  }

  io.use(async (socket, next) => {
    try {
      const raw =
        socket.handshake.auth?.token ||
        (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '') ||
        socket.handshake.query?.token;
      if (!raw) {
        console.log('[rt] AUTH FAIL: no token on handshake');
        return next(new Error('UNAUTHENTICATED'));
      }

      let payload;
      try {
        payload = verifyAccessToken(raw);
      } catch {
        console.log('[rt] AUTH FAIL: invalid/expired token');
        return next(new Error('TOKEN_INVALID'));
      }

      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: { id: true, name: true },
      });
      if (!user) {
        console.log('[rt] AUTH FAIL: user not found for token sub', payload.sub);
        return next(new Error('USER_NOT_FOUND'));
      }

      socket.data.userId = user.id;
      socket.data.name = user.name || 'Learner';
      next();
    } catch (err) {
      next(err);
    }
  });

  startBillingWatchdog(io);

  io.on('connection', (socket) => {
    addPresence(socket.data.userId, socket.id);
    console.log(
      `[rt] CONNECT  user=${socket.data.userId} (${socket.data.name})  online=${onlineCount()}`
    );

    registerMatchmaking(io, socket);
    registerSignaling(io, socket);
    registerTutorCalls(io, socket);
    deliverPendingInvites(io, socket);

    // Lobby helper: how many people are currently online (rough availability).
    socket.on('online_count', () => socket.emit('online_count', { count: onlineCount() }));

    socket.on('disconnect', async () => {
      console.log(`[rt] DISCONNECT user=${socket.data.userId} (${socket.data.name})`);
      leaveQueue(socket);
      removePresence(socket.data.userId, socket.id);
      cleanupTutorInvites(io, socket); // after removePresence so "last device" is accurate
      await handleDisconnect(io, socket);
    });
  });

  return io;
}
