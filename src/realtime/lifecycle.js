// Tiny shared flag for graceful shutdown. While draining, the realtime layer
// stops STARTING new calls/matches; existing calls keep going and are finalized
// by the shutdown sequence in server.js. Kept in its own module so the
// matchmaker, the tutor-call handlers, and the server can all read/set it
// without a circular import.
let draining = false;

export function isDraining() {
  return draining;
}

export function beginDraining() {
  draining = true;
}
