import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { createRoom } from './rooms.js';
import { socketsForUser } from './presence.js';
import { getBlockedUserIds } from '../services/safety.service.js';
import { getTutorCallAccessById } from '../services/entitlement.service.js';
import { pushToUser } from '../services/push.service.js';

import { isDraining } from './lifecycle.js';

// =============================================================================
// Paid tutor calls — a RING flow, unlike random matchmaking's instant pairing:
// the tutor must ACCEPT before a room is created (tutors are people at work,
// not a queue). Two entry points share it:
//
//   'tutor_call_request' { tutorUserId, type? }  — learner picked a tutor
//   'find_tutor'         { type? }               — auto-match any available
//
// Events emitted:
//   learner: 'tutor_ringing' | 'tutor_unavailable' | 'call_denied' | 'matched'
//   tutor:   'tutor_incoming' { inviteId, learner, type } | 'matched'
//   tutor:   answers with 'tutor_accept' / 'tutor_decline' { inviteId }
//
// Billing happens in rooms.js (kind: 'TUTOR'): learner pays prepaid balance,
// tutor earns per second — none of it lives here.
// =============================================================================

const invites = new Map(); // inviteId -> { learnerSocket, tutorUserId, type, timer, excluded }

function clearInvite(inviteId) {
  const inv = invites.get(inviteId);
  if (!inv) return null;
  clearTimeout(inv.timer);
  invites.delete(inviteId);
  return inv;
}

// Does this user have at least one registered push device? Lets a toggled-on
// tutor be rung by NOTIFICATION when their app is closed.
async function hasPushDevice(userId) {
  const n = await prisma.deviceToken.count({ where: { userId } }).catch(() => 0);
  return n > 0;
}

// A tutor is callable when: profile APPROVED + toggled online + reachable —
// either live on a socket (in-app ring) or via a push device (notification
// ring that opens the app). Returns the profile row or null.
async function callableTutor(tutorUserId) {
  const p = await prisma.tutorProfile.findUnique({
    where: { userId: tutorUserId },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!p || p.status !== 'APPROVED' || !p.isOnline) return null;
  if (socketsForUser(tutorUserId).length) return p;
  return (await hasPushDevice(tutorUserId)) ? p : null;
}

// Ring one tutor on all their devices; on timeout tell the learner.
// If the tutor has NO live socket (app closed), we ring by push notification
// instead and give them a longer window to open the app — on connect,
// deliverPendingInvites() below re-delivers the invite so the incoming-call
// sheet appears the moment the app is up.
async function ring(io, learnerSocket, tutorProfile, type, excluded) {
  const inviteId = randomUUID();
  const liveSockets = socketsForUser(tutorProfile.userId);
  // Cold-starting an app takes time; a push ring needs a longer window.
  const timeoutMs = liveSockets.length
    ? config.tutorMarket.inviteTimeoutMs
    : Math.max(config.tutorMarket.inviteTimeoutMs, 60_000);

  const timer = setTimeout(() => {
    const inv = clearInvite(inviteId);
    if (!inv) return;
    inv.learnerSocket.emit('tutor_unavailable', {
      tutorUserId: inv.tutorUserId,
      reason: 'NO_ANSWER',
      message: 'The tutor did not answer. Try another tutor.',
    });
  }, timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  invites.set(inviteId, {
    learnerSocket,
    tutorUserId: tutorProfile.userId,
    type,
    timer,
    excluded,
  });

  for (const sid of liveSockets) {
    io.to(sid).emit('tutor_incoming', {
      inviteId,
      type,
      learner: { id: learnerSocket.data.userId, name: learnerSocket.data.name },
    });
  }
  // ALWAYS ring by push too, not just when the app is closed. The common case
  // is a BACKGROUNDED tutor whose socket is still alive: their frozen JS never
  // shows the socket-only ring, and the invite dies as NO_ANSWER. The push
  // reaches them regardless. Foregrounded tutors don't double-ring — the app
  // suppresses the tutor_call banner while foregrounded (lib/push.ts), where
  // the in-app incoming sheet is the ring.
  pushToUser(tutorProfile.userId, {
    title: '📞 Incoming tutor call',
    body: `${learnerSocket.data.name || 'A learner'} wants a lesson — open Huevix to answer`,
    data: { type: 'tutor_call', inviteId },
  }).catch(() => { });
  learnerSocket.emit('tutor_ringing', {
    inviteId,
    type,
    tutor: { id: tutorProfile.userId, name: tutorProfile.user?.name || 'Tutor' },
  });
}

// Called on every socket connection: if this user is a tutor with a live
// invite that arrived while their app was closed (push ring), deliver it now.
export function deliverPendingInvites(io, socket) {
  for (const [inviteId, inv] of invites) {
    if (inv.tutorUserId === socket.data.userId && inv.learnerSocket.connected) {
      socket.emit('tutor_incoming', {
        inviteId,
        type: inv.type,
        learner: { id: inv.learnerSocket.data.userId, name: inv.learnerSocket.data.name },
      });
    }
  }
}

// Shared pre-flight for both entry points: learner must have prepaid balance
// (tutor calls never use free minutes) and must not already be ringing someone.
async function preflight(socket, type) {
  if (isDraining()) {
    socket.emit('call_denied', {
      reason: 'SERVER_DRAINING',
      message: 'The server is updating. Please try again in a moment.',
    });
    return { ok: false, reason: 'SERVER_DRAINING' };
  }
  for (const inv of invites.values()) {
    if (inv.learnerSocket.id === socket.id) return { ok: false, reason: 'ALREADY_RINGING' };
  }
  let access;
  try {
    access = await getTutorCallAccessById(socket.data.userId);
  } catch {
    access = { allowed: false, reason: 'ACCESS_CHECK_FAILED', message: 'Try again in a moment.' };
  }
  if (!access.allowed) {
    socket.emit('call_denied', {
      reason: access.reason || 'NO_TUTOR_BALANCE',
      message: access.message || 'Recharge to talk to a tutor.',
      balanceSeconds: access.balanceSeconds,
    });
    return { ok: false, reason: access.reason };
  }
  return { ok: true, type: type === 'AUDIO' ? 'AUDIO' : 'VIDEO' };
}

export function registerTutorCalls(io, socket) {
  // --- Learner picked a specific tutor from GET /tutors/online --------------
  socket.on('tutor_call_request', async (payload = {}) => {
    const pf = await preflight(socket, payload.type);
    if (!pf.ok) return;

    const tutorUserId = String(payload.tutorUserId || '');
    if (!tutorUserId || tutorUserId === socket.data.userId) return;

    let blocked = new Set();
    try {
      blocked = await getBlockedUserIds(socket.data.userId);
    } catch {
      /* fail open on blocks only; credit gate already passed */
    }
    if (blocked.has(tutorUserId)) {
      return socket.emit('tutor_unavailable', { tutorUserId, reason: 'BLOCKED' });
    }

    const profile = await callableTutor(tutorUserId);
    if (!profile) {
      return socket.emit('tutor_unavailable', {
        tutorUserId,
        reason: 'OFFLINE',
        message: 'This tutor just went offline.',
      });
    }
    await ring(io, socket, profile, pf.type, new Set([tutorUserId]));
  });

  // --- Auto-match: ring a random available tutor -----------------------------
  socket.on('find_tutor', async (payload = {}) => {
    const pf = await preflight(socket, payload.type);
    if (!pf.ok) return;

    let blocked = new Set();
    try {
      blocked = await getBlockedUserIds(socket.data.userId);
    } catch {
      /* see above */
    }

    const candidates = await prisma.tutorProfile.findMany({
      where: { status: 'APPROVED', isOnline: true, userId: { not: socket.data.userId } },
      include: { user: { select: { id: true, name: true } } },
      take: 50,
    });
    const available = candidates.filter(
      (p) => socketsForUser(p.userId).length && !blocked.has(p.userId)
    );
    if (!available.length) {
      return socket.emit('tutor_unavailable', {
        reason: 'NONE_ONLINE',
        message: 'No tutors are available right now. Try again soon.',
      });
    }
    const pick = available[Math.floor(Math.random() * available.length)];
    await ring(io, socket, pick, pf.type, new Set([pick.userId]));
  });

  // --- Tutor answers ----------------------------------------------------------
  socket.on('tutor_accept', async (payload = {}) => {
    const inv = invites.get(String(payload.inviteId || ''));
    // Only the invited tutor may accept, and only while the invite is live.
    if (!inv || inv.tutorUserId !== socket.data.userId) return;
    clearInvite(payload.inviteId);

    // Server is draining: don't spin up a new room; release both sides cleanly.
    if (isDraining()) {
      socket.emit('tutor_unavailable', { reason: 'SERVER_DRAINING' });
      inv.learnerSocket.emit('call_denied', {
        reason: 'SERVER_DRAINING',
        message: 'The server is updating. Please try again in a moment.',
      });
      return;
    }

    if (!inv.learnerSocket.connected) {
      return socket.emit('tutor_unavailable', { reason: 'LEARNER_LEFT' });
    }

    // Re-check the learner's balance at accept time (it may have drained in a
    // parallel call between ring and answer).
    let access;
    try {
      access = await getTutorCallAccessById(inv.learnerSocket.data.userId);
    } catch {
      access = { allowed: false };
    }
    if (!access.allowed) {
      socket.emit('tutor_unavailable', { reason: 'LEARNER_NO_BALANCE' });
      inv.learnerSocket.emit('call_denied', {
        reason: 'NO_TUTOR_BALANCE',
        message: 'Recharge to talk to a tutor.',
      });
      return;
    }

    // Learner is the CALLER (sends the first WebRTC offer); tutor is callee.
    const room = await createRoom({
      callerSocket: inv.learnerSocket,
      calleeSocket: socket,
      type: inv.type,
      kind: 'TUTOR',
    });

    inv.learnerSocket.emit('matched', {
      roomId: room.roomId,
      callId: room.callId,
      role: 'caller',
      type: inv.type,
      kind: 'TUTOR',
      peer: { id: socket.data.userId, name: socket.data.name },
    });
    socket.emit('matched', {
      roomId: room.roomId,
      callId: room.callId,
      role: 'callee',
      type: inv.type,
      kind: 'TUTOR',
      peer: { id: inv.learnerSocket.data.userId, name: inv.learnerSocket.data.name },
    });
  });

  socket.on('tutor_decline', (payload = {}) => {
    const inv = invites.get(String(payload.inviteId || ''));
    if (!inv || inv.tutorUserId !== socket.data.userId) return;
    clearInvite(payload.inviteId);
    inv.learnerSocket.emit('tutor_unavailable', {
      tutorUserId: inv.tutorUserId,
      reason: 'DECLINED',
      message: 'The tutor declined. Try another tutor.',
    });
  });

  // Learner cancels while ringing.
  socket.on('tutor_cancel', (payload = {}) => {
    const inv = invites.get(String(payload.inviteId || ''));
    if (!inv || inv.learnerSocket.id !== socket.id) return;
    clearInvite(payload.inviteId);
    for (const sid of socketsForUser(inv.tutorUserId)) {
      io.to(sid).emit('tutor_cancelled', { inviteId: payload.inviteId });
    }
  });
}

// Called from socket.js on disconnect: kill any invite this socket was part of
// (either side), and notify the other party.
export function cleanupTutorInvites(io, socket) {
  for (const [inviteId, inv] of invites) {
    if (inv.learnerSocket.id === socket.id) {
      clearInvite(inviteId);
      for (const sid of socketsForUser(inv.tutorUserId)) {
        io.to(sid).emit('tutor_cancelled', { inviteId });
      }
    } else if (inv.tutorUserId === socket.data.userId && !socketsForUser(inv.tutorUserId).length) {
      // Tutor's LAST device disconnected mid-ring.
      clearInvite(inviteId);
      inv.learnerSocket.emit('tutor_unavailable', {
        tutorUserId: inv.tutorUserId,
        reason: 'OFFLINE',
      });
    }
  }
}
