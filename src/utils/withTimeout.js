import { config } from '../config/env.js';
import { ApiError } from './ApiError.js';

// Races a promise against a deadline. If the promise doesn't settle in time we
// reject with a 503 ApiError so the central error handler returns a clean
// "service unavailable" instead of leaving the request hanging on a stalled
// upstream (OpenAI / Azure / Razorpay). `label` is included in the message and
// the server-side log so a timeout is easy to attribute.
//
// NOTE: this bounds how long WE wait, not the upstream socket — the underlying
// request may still be in flight. Where an SDK exposes an AbortSignal, pass it
// too; this helper is the universal backstop for SDKs that don't.
export function withTimeout(
  promise,
  { ms = config.externalTimeoutMs, label = 'external service' } = {}
) {
  let timer;
  const timeout = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new ApiError(503, `${label} timed out after ${ms}ms`, 'UPSTREAM_TIMEOUT'));
    }, ms);
    // Don't keep the event loop alive solely for this timer.
    if (typeof timer.unref === 'function') timer.unref();
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
