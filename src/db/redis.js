import Redis from 'ioredis';
import { config } from '../config/env.js';

// Shared Redis connection(s) for the realtime layer's cross-instance state
// (matchmaking queue, presence, rooms, tutor invites) and the Socket.IO adapter.
//
// SINGLE-INSTANCE MODE (no REDIS_URL): every getter returns null and the realtime
// layer falls back to its original in-process Maps — byte-for-byte the current
// behavior. Redis is ONLY required to run more than one API instance.
//
// We keep three connections: the Socket.IO Redis adapter needs a dedicated
// pub + sub pair (a subscriber connection can't issue normal commands), and the
// app's own state uses a third, general-purpose connection.

let _main = null;
let _pub = null;
let _sub = null;

export function redisEnabled() {
  return Boolean(config.redis.url);
}

function make(label) {
  const client = new Redis(config.redis.url, {
    // Fail a command after a few retries instead of queueing forever when Redis
    // is unreachable; callers treat Redis errors as "act local" where safe.
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
  });
  client.on('error', (e) => console.error(`[redis:${label}] ${e.message}`));
  client.on('connect', () => console.log(`[redis:${label}] connected`));
  return client;
}

// General-purpose connection for the app's own reads/writes.
export function getRedis() {
  if (!redisEnabled()) return null;
  if (!_main) _main = make('main');
  return _main;
}

// Dedicated pub/sub pair for the Socket.IO adapter (createAdapter(pub, sub)).
export function getPubSub() {
  if (!redisEnabled()) return null;
  if (!_pub) _pub = make('pub');
  if (!_sub) {
    _sub = _pub.duplicate();
    _sub.on('error', (e) => console.error(`[redis:sub] ${e.message}`));
  }
  return { pub: _pub, sub: _sub };
}

export async function closeRedis() {
  await Promise.allSettled([_main?.quit(), _pub?.quit(), _sub?.quit()]);
  _main = _pub = _sub = null;
}
