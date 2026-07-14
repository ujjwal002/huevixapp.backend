// Tracks which users are currently connected to the realtime layer. A single
// user may have more than one live socket (e.g. phone + web), so we keep a set
// of socket ids per user. This backs "who is available to match" and the
// online count shown in the lobby.
const userSockets = new Map(); // userId -> Set<socketId>

export function addPresence(userId, socketId) {
  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socketId);
}

export function removePresence(userId, socketId) {
  const set = userSockets.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) userSockets.delete(userId);
}

export function isOnline(userId) {
  return userSockets.has(userId);
}

export function onlineCount() {
  return userSockets.size;
}

// All live socket ids for a user (a user can be connected from several
// devices). Used to ring EVERY device on an incoming tutor call.
export function socketsForUser(userId) {
  return [...(userSockets.get(userId) || [])];
}
