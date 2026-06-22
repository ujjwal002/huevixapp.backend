import { getRoom, peerSocketId, markActive, endRoom } from './rooms.js';

// Relay a WebRTC signaling payload to the OTHER peer in the room.
//
// We never trust a client-supplied target: we resolve the room, verify the
// sender is actually a participant, then forward to its peer. This keeps the
// server a dumb, safe relay — it never inspects or stores SDP/ICE.
function relay(io, socket, event) {
  return async (payload = {}) => {
    const room = getRoom(payload.roomId);
    if (!room) return;
    if (room.callerSocketId !== socket.id && room.calleeSocketId !== socket.id) return;
    await markActive(room.roomId);
    const target = peerSocketId(room, socket.id);
    io.to(target).emit(event, { ...payload, roomId: room.roomId });
  };
}

export function registerSignaling(io, socket) {
  socket.on('signal:offer', relay(io, socket, 'signal:offer'));
  socket.on('signal:answer', relay(io, socket, 'signal:answer'));
  socket.on('signal:ice', relay(io, socket, 'signal:ice'));

  // Either side ends the call: tell the peer and finalize the Call row.
  socket.on('hangup', async (payload = {}) => {
    const room = getRoom(payload.roomId);
    if (!room) return;
    if (room.callerSocketId !== socket.id && room.calleeSocketId !== socket.id) return;
    const target = peerSocketId(room, socket.id);
    io.to(target).emit('peer_left', { roomId: room.roomId, reason: 'hangup' });
    await endRoom(room.roomId, { status: 'ENDED' });
  });
}
