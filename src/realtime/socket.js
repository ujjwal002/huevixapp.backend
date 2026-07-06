import { Server } from 'socket.io';
import { verifyAccessToken } from '../utils/jwt.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { addPresence, removePresence, onlineCount } from './presence.js';
import { registerMatchmaking, leaveQueue } from './matchmaking.js';
import { registerTutorCalls, cleanupTutorInvites } from './tutorCalls.js';
import { registerSignaling } from './signaling.js';
import { handleDisconnect } from './rooms.js';

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

  io.on('connection', (socket) => {
    addPresence(socket.data.userId, socket.id);
    console.log(`[rt] CONNECT  user=${socket.data.userId} (${socket.data.name})  online=${onlineCount()}`);

    registerMatchmaking(io, socket);
    registerSignaling(io, socket);
    registerTutorCalls(io, socket);

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