import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { timingSafeEqualStr } from '../utils/crypto.js';

// Rewarded-ad verification.
//
// The /ads/reward endpoint grants a free user a bonus speaking credit. Without
// verification, anyone with a token could mint the daily maximum by calling it
// with an empty body. To close that, the client must forward a signed reward
// token issued by a trusted party; we verify it before granting.
//
// Verification model (fits the current "client calls our API" architecture):
//   - token:     opaque string identifying the ad view (e.g. AdMob transaction
//                id, optionally "<id>.<unixSeconds>" to bound replay).
//   - signature: HMAC-SHA256(AD_REWARD_SECRET, token), hex.
//
// Modes:
//   - mock (dev/CI): accept anything, so the demo flow has zero friction.
//   - production, secret configured: require a valid signature (constant-time).
//   - production, NO secret configured: FAIL CLOSED (grant nothing).
//
// PRODUCTION UPGRADE: the gold standard is AdMob Server-Side Verification — a
// server-to-server callback AdMob makes directly to your backend (the client is
// never trusted). Drop it in by replacing `verifyAdReward` and granting from
// that callback keyed by user_id.

const REPLAY_WINDOW_SECONDS = 10 * 60; // tokens carrying a timestamp expire after 10 min

export function verifyAdReward({ token, signature } = {}) {
  if (config.mockExternal) return { ok: true, mock: true };

  const secret = config.ads.rewardSecret;
  if (!secret) {
    // Fail closed: real mode but no way to verify -> never grant.
    return { ok: false, reason: 'AD_VERIFICATION_UNCONFIGURED' };
  }
  if (!token || !signature) {
    return { ok: false, reason: 'AD_TOKEN_MISSING' };
  }

  const expected = crypto.createHmac('sha256', secret).update(String(token)).digest('hex');
  if (!timingSafeEqualStr(expected, signature)) {
    return { ok: false, reason: 'AD_SIGNATURE_INVALID' };
  }

  // Optional freshness check: if the token embeds a unix timestamp as the last
  // dot-separated segment, reject stale tokens to limit replay.
  const parts = String(token).split('.');
  const maybeTs = Number(parts[parts.length - 1]);
  if (parts.length > 1 && Number.isFinite(maybeTs)) {
    const ageSeconds = Math.abs(Date.now() / 1000 - maybeTs);
    if (ageSeconds > REPLAY_WINDOW_SECONDS) {
      return { ok: false, reason: 'AD_TOKEN_EXPIRED' };
    }
  }

  return { ok: true };
}
