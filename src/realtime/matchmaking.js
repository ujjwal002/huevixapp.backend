import { createRoom } from './rooms.js';
import { getBlockedUserIds } from '../services/safety.service.js';
import { getCallAccessById } from '../services/entitlement.service.js';

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
    if (waiting.some((s) => s.id === socket.id)) return;

    const type = payload.type === 'AUDIO' ? 'AUDIO' : 'VIDEO';

    // Credit gate: the requester must have call time left (free daily + prepaid).
    // The waiting partner already passed this check when they queued (and can't
    // be charged while waiting), so checking the requester here is sufficient.
    let access;
    try {
      access = await getCallAccessById(socket.data.userId);
    } catch {
      access = { allowed: true };
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