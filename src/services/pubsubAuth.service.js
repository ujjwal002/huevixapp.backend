import { OAuth2Client } from 'google-auth-library';
import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';

// =============================================================================
// Google Cloud Pub/Sub push — OIDC token verification.
//
// When a Pub/Sub push subscription is configured WITH AUTHENTICATION, Google
// signs an OIDC JWT and sends it as `Authorization: Bearer <jwt>` on every push
// request. Verifying it proves the request originated from Google's Pub/Sub for
// OUR subscription — a stronger guarantee than the shared URL-path secret the
// RTDN endpoint also checks. We verify:
//   * signature — against Google's public certs (handled by verifyIdToken)
//   * audience  — must equal config.googlePlay.rtdnAudience (whatever you set on
//                 the authenticated push subscription)
//   * issuer    — must be Google
//   * (optional) email — the push subscription's service-account address, when
//                 config.googlePlay.rtdnServiceAccountEmail is set
//
// google-auth-library caches Google's certs internally, so after warmup this is
// a local signature check on the hot path (no network call per request).
// =============================================================================

let _client;
function client() {
  if (!_client) _client = new OAuth2Client();
  return _client;
}

const GOOGLE_ISSUERS = new Set(['https://accounts.google.com', 'accounts.google.com']);

// A timeout / network failure means we COULDN'T verify (not that the token is
// bad); the caller should return 5xx so Pub/Sub retries. withTimeout raises a
// 503 ApiError on timeout; treat that and common network errors as transient.
function isTransient(err) {
  if (err?.statusCode === 503) return true;
  const code = err?.code || err?.cause?.code;
  return ['ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED'].includes(code);
}

// Verify a Pub/Sub push OIDC token.
//   -> { ok: true, email }     token is valid
//   -> { ok: false, reason }   token is present but INVALID
//   throws                     verification couldn't complete (transient); the
//                              caller should 5xx so Pub/Sub retries later
export async function verifyPubSubPushToken(token) {
  const audience = config.googlePlay.rtdnAudience;
  if (!audience) {
    // The caller guards on this, but be explicit: with no configured audience
    // we cannot safely verify, so treat as invalid rather than accept blindly.
    return { ok: false, reason: 'AUDIENCE_NOT_CONFIGURED' };
  }

  let ticket;
  try {
    ticket = await withTimeout(client().verifyIdToken({ idToken: token, audience }), {
      label: 'Pub/Sub OIDC verification',
    });
  } catch (err) {
    if (isTransient(err)) throw err; // let the caller 5xx -> Pub/Sub retries
    return { ok: false, reason: 'TOKEN_INVALID' }; // bad signature / aud / expired
  }

  const payload = ticket.getPayload();
  if (!payload) return { ok: false, reason: 'NO_PAYLOAD' };
  if (!GOOGLE_ISSUERS.has(payload.iss)) return { ok: false, reason: 'BAD_ISSUER' };

  const expectedEmail = config.googlePlay.rtdnServiceAccountEmail;
  if (expectedEmail && (payload.email !== expectedEmail || payload.email_verified !== true)) {
    return { ok: false, reason: 'BAD_SERVICE_ACCOUNT' };
  }

  return { ok: true, email: payload.email || null };
}