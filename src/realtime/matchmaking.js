import { createRoom } from './rooms.js';
import { getBlockedUserIds } from '../services/safety.service.js';
import { getCallAccessById } from '../services/entitlement.service.js';

import { isDraining } from './lifecycle.js';

// FIFO queue of sockets waiting for a partner. Entries are live socket objects
// so we can check `.connected` and read `.data.userId` directly.
//
// "Find People" model: a user taps to enter the queue; the moment another
// (different) user is waiting, we pair them. No invites, no codes.
const waiting = [];

function dequeueSocket(socketId) {
  const i = waiting.findIndex((s) => s.id === socketId);
  if (i !== -1) waiting.splice(i, 1);
}

export function leaveQueue(socket) {
  dequeueSocket(socket.id);
}

export function queueLength() {
  return waiting.length;
}

export function registerMatchmaking(io, socket) {
  socket.on('find_partner', async (payload = {}) => {
    // Ignore a duplicate tap from a socket already in the queue.

    if (isDraining()) {
      socket.emit('call_denied', {
        reason: 'SERVER_DRAINING',
        message: 'The server is updating. Please try again in a moment.',
      });
      return;
    }
    // Ignore a duplicate tap from a socket already in the queue.
    if (waiting.some((s) => s.id === socket.id)) return;

    const type = payload.type === 'AUDIO' ? 'AUDIO' : 'VIDEO';
    // Remember this socket's requested type so we only pair like with like
    // (audio↔audio, video↔video) and so each side is gated for the right type.
    socket.data.callType = type;

    // Credit gate: the requester must have time for THIS type. Audio can use the
    // free daily allowance + prepaid; video requires prepaid balance only. The
    // waiting partner already passed the same-type check when they queued.
    // Fail CLOSED on a credit-check error: a random VIDEO call can spend coins,
    // so if we can't confirm the user can afford it we deny and let them retry
    // rather than granting a call we might not be able to bill. (Mirrors the
    // tutor-call preflight in tutorCalls.js.)
    let access;
    try {
      access = await getCallAccessById(socket.data.userId, type);
    } catch {
      access = {
        allowed: false,
        reason: 'ACCESS_CHECK_FAILED',
        message: 'Could not check your balance. Please try again in a moment.',
      };
    }
    if (!access.allowed) {
      console.log(`[mm] DENIED  user=${socket.data.userId} reason=${access.reason}`);
      socket.emit('call_denied', {
        reason: access.reason || 'NO_CALL_BALANCE',
        message: access.message || 'You are out of call minutes.',
        balanceSeconds: access.balanceSeconds,
        freeSecondsLeft: access.freeSecondsLeft,
      });
      return;
    }

    // Drop any stale (disconnected) sockets left in the queue.
    for (let i = waiting.length - 1; i >= 0; i--) {
      if (!waiting[i].connected) waiting.splice(i, 1);
    }

    // Who can't this user be matched with (blocked either direction)?
    let blocked = new Set();
    try {
      blocked = await getBlockedUserIds(socket.data.userId);
    } catch {
      blocked = new Set();
    }

    // First acceptable partner: a DIFFERENT, non-blocked, still-connected user.
    // We only remove the chosen partner from the queue — skipped candidates stay
    // so they can still match someone else.
    let idx = -1;
    for (let i = 0; i < waiting.length; i++) {
      const c = waiting[i];
      if (c.data.userId === socket.data.userId) continue;
      if (c.data.callType !== type) continue; // pair audio↔audio, video↔video only
      if (blocked.has(c.data.userId)) continue;
      idx = i;
      break;
    }

    if (idx === -1) {
      waiting.push(socket);
      console.log(`[mm] SEARCHING user=${socket.data.userId}  waiting=${waiting.length}`);
      socket.emit('searching', { queued: true });
      return;
    }

    const partner = waiting.splice(idx, 1)[0];
    console.log(`[mm] MATCH  caller=${partner.data.userId}  callee=${socket.data.userId}`);

    // Pair them. The one who was already waiting becomes the CALLER and sends
    // the first offer once both sides have their local media.
    const room = await createRoom({ callerSocket: partner, calleeSocket: socket, type });

    partner.emit('matched', {
      roomId: room.roomId,
      callId: room.callId,
      role: 'caller',
      type,
      peer: { id: socket.data.userId, name: socket.data.name },
    });
    socket.emit('matched', {
      roomId: room.roomId,
      callId: room.callId,
      role: 'callee',
      type,
      peer: { id: partner.data.userId, name: partner.data.name },
    });
  });

  socket.on('cancel_find', () => {
    dequeueSocket(socket.id);
    socket.emit('search_cancelled', {});
  });
}
