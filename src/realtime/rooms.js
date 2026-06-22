import { randomUUID } from 'node:crypto';
import { prisma } from '../db/prisma.js';

import { consumeCallSeconds } from '../services/entitlement.service.js';


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
export async function createRoom({ callerSocket, calleeSocket, type = 'VIDEO' }) {
  const roomId = randomUUID();
  const callerId = callerSocket.data.userId;
  const calleeId = calleeSocket.data.userId;

  const call = await prisma.call.create({
    data: { callerId, calleeId, type, status: 'CONNECTING' },
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
    startedAt: Date.now(),
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

  const durationSec = Math.max(0, Math.round((Date.now() - room.startedAt) / 1000));
  const finalStatus = status || (room.markedActive ? 'ENDED' : 'MISSED');
  await prisma.call
    .update({
      where: { id: room.callId },
      data: { status: finalStatus, endedAt: new Date(), durationSec },
    })
    .catch(() => {});

  if (finalStatus === 'ENDED' && durationSec > 0) {
    await Promise.all([
      consumeCallSeconds(room.callerId, durationSec).catch(() => {}),
      consumeCallSeconds(room.calleeId, durationSec).catch(() => {}),
    ]);
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
