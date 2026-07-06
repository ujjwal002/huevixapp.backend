import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';

import {
  consumeCallSeconds,
  consumeBalanceSeconds,
  remainingCallSeconds,
} from '../services/entitlement.service.js';
import { accrueEarning } from '../services/tutor.service.js';


// Active 1:1 call rooms, keyed by roomId. This is the in-memory source of truth
// for a live call; the Call DB row is the durable record (for history/auditing).
//
// We deliberately keep this in a single process. With more than one API
// instance behind the tunnel/load balancer you'd move this routing to Redis
// pub/sub — but a single instance is correct for launch and keeps it simple.
const rooms = new Map(); // roomId -> room
const socketRoom = new Map(); // socketId -> roomId (fast reverse lookup)

// Create a room for a matched pair and persist a CONNECTING Call row. The
// "caller" is the side that will send the first WebRTC offer.
export async function createRoom({ callerSocket, calleeSocket, type = 'VIDEO', kind = 'RANDOM' }) {
  const roomId = randomUUID();
  const callerId = callerSocket.data.userId;
  const calleeId = calleeSocket.data.userId;

  const call = await prisma.call.create({
    data: { callerId, calleeId, type, kind, status: 'CONNECTING' },
    select: { id: true },
  });

  const room = {
    roomId,
    callId: call.id,
    callerId,
    calleeId,
    callerSocketId: callerSocket.id,
    calleeSocketId: calleeSocket.id,
    type,
    kind, // 'RANDOM' | 'TUTOR' — for TUTOR the callee is always the tutor
    startedAt: Date.now(),
    activeAt: null, // set on first signaling; billing clock starts HERE
    markedActive: false,
  };
  rooms.set(roomId, room);
  socketRoom.set(callerSocket.id, roomId);
  socketRoom.set(calleeSocket.id, roomId);

  callerSocket.join(roomId);
  calleeSocket.join(roomId);
  return room;
}

export function getRoom(roomId) {
  return rooms.get(roomId);
}

export function roomIdForSocket(socketId) {
  return socketRoom.get(socketId);
}

// Given a room and one participant's socket id, return the other participant's.
export function peerSocketId(room, socketId) {
  return room.callerSocketId === socketId ? room.calleeSocketId : room.callerSocketId;
}

// Mark the call ACTIVE the first time signaling actually flows (i.e. the two
// sides started negotiating media). Used to distinguish a real conversation
// from a MISSED match that never connected.
export async function markActive(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.markedActive) return;
  room.markedActive = true;
  room.activeAt = Date.now();
  await prisma.call
    .update({ where: { id: room.callId }, data: { status: 'ACTIVE' } })
    .catch(() => {});
}

// Finalize a room: write duration + final status to the Call row and clear the
// in-memory maps. A room that never went active is recorded as MISSED.
export async function endRoom(roomId, { status } = {}) {
  const room = rooms.get(roomId);
  if (!room) return null;
  rooms.delete(roomId);
  socketRoom.delete(room.callerSocketId);
  socketRoom.delete(room.calleeSocketId);

  // Bill TALK time, not handshake time: the clock starts when signaling first
  // flowed (activeAt), falling back to match time for legacy safety.
  const billStart = room.activeAt || room.startedAt;
  const durationSec = Math.max(0, Math.round((Date.now() - billStart) / 1000));
  const finalStatus = status || (room.markedActive ? 'ENDED' : 'MISSED');
  await prisma.call
    .update({
      where: { id: room.callId },
      data: { status: finalStatus, endedAt: new Date(), durationSec },
    })
    .catch(() => {});

  if (finalStatus === 'ENDED' && durationSec > 0) {
    if (room.kind === 'TUTOR') {
      // Learner (caller) pays from the prepaid balance ONLY; the tutor
      // (callee) pays nothing and EARNS per second. accrueEarning is
      // idempotent on callId, so a crash-replay can't double-pay.
      await Promise.all([
        consumeBalanceSeconds(room.callerId, durationSec).catch(() => {}),
        accrueEarning({
          tutorUserId: room.calleeId,
          callId: room.callId,
          seconds: durationSec,
        }).catch((e) => console.error('[tutor] earning accrual failed:', e.message)),
      ]);
    } else {
      await Promise.all([
        consumeCallSeconds(room.callerId, durationSec, room.type).catch(() => {}),
        consumeCallSeconds(room.calleeId, durationSec, room.type).catch(() => {}),
      ]);
    }
  }
  return room;
}

// On socket disconnect: if it was in a live call, notify the peer and finalize.
export async function handleDisconnect(io, socket) {
  const roomId = socketRoom.get(socket.id);
  if (!roomId) return;
  const room = rooms.get(roomId);
  if (!room) return;
  const peer = peerSocketId(room, socket.id);
  io.to(peer).emit('peer_left', { roomId, reason: 'disconnected' });
  await endRoom(roomId);
}

export function activeCallCount() {
  return rooms.size;
}

// ===========================================================================
// Billing watchdog — LIVE balance enforcement.
//
// Charging happens at call end; without this, a call could run far past what
// the payer can afford (gate-at-start only). Every WATCHDOG_MS we compare each
// active room's elapsed talk time against what its payer(s) can afford:
//   RANDOM: both participants pay -> whoever runs out first ends the call.
//   TUTOR:  only the learner (caller) pays.
// A LOW warning fires once so the app can show "1 minute left".
// When time is up: the exhausted payer gets call_denied (recharge message),
// everyone else gets peer_left, and the room is finalized (which performs the
// charge; the spend floor absorbs the few seconds of watchdog latency).
// ===========================================================================
const WATCHDOG_MS = 10_000;
const LOW_WARN_SEC = 60;

// Per-payer affordable seconds: [{ userId, socketId, affordable }]
async function roomPayerBudgets(room) {
  const payers =
    room.kind === 'TUTOR'
      ? [{ userId: room.callerId, socketId: room.callerSocketId }]
      : [
          { userId: room.callerId, socketId: room.callerSocketId },
          { userId: room.calleeId, socketId: room.calleeSocketId },
        ];
  const opts = { kind: room.kind, type: room.type };
  return Promise.all(
    payers.map(async (p) => ({
      ...p,
      affordable: await remainingCallSeconds(p.userId, opts).catch(() => Infinity),
    }))
  );
}

async function watchdogTick(io) {
  for (const room of [...rooms.values()]) {
    if (!room.markedActive || !room.activeAt) continue;
    try {
      const elapsed = Math.round((Date.now() - room.activeAt) / 1000);
      // Cache each payer's affordable total; balances only change at call
      // end, so one DB read per payer per call is enough — refreshed every
      // ~60s of talk in case of concurrent activity on the account.
      if (!room._budgets || elapsed - (room._budgetsAt ?? 0) > 60) {
        room._budgets = await roomPayerBudgets(room);
        room._budgetsAt = elapsed;
      }
      const exhausted = room._budgets.filter((b) => b.affordable - elapsed <= 0);
      const minLeft = Math.min(...room._budgets.map((b) => b.affordable - elapsed));

      if (minLeft <= LOW_WARN_SEC && minLeft > 0 && !room._lowWarned) {
        room._lowWarned = true;
        io.to(room.roomId).emit('call_balance_low', {
          roomId: room.roomId,
          secondsLeft: Math.max(0, minLeft),
        });
      }

      if (exhausted.length > 0) {
        const exhaustedSockets = new Set(exhausted.map((b) => b.socketId));
        // Whoever ran out gets the recharge message...
        for (const sid of exhaustedSockets) {
          io.to(sid).emit('call_denied', {
            reason: 'BALANCE_EXHAUSTED',
            message:
              room.kind === 'TUTOR'
                ? 'You ran out of coins. Recharge to keep talking to tutors.'
                : 'Your call time ran out. Recharge to keep practising.',
          });
        }
        // ...everyone else just sees the peer leave.
        for (const sid of [room.callerSocketId, room.calleeSocketId]) {
          if (!exhaustedSockets.has(sid)) {
            io.to(sid).emit('peer_left', { roomId: room.roomId, reason: 'balance_exhausted' });
          }
        }
        await endRoom(room.roomId, { status: 'ENDED' });
      }
    } catch (e) {
      console.error('[billing-watchdog]', e.message);
    }
  }
}

let watchdogTimer = null;
export function startBillingWatchdog(io) {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => watchdogTick(io), WATCHDOG_MS);
  if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref();
}