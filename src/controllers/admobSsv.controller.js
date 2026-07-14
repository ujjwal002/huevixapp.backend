// AdMob Server-Side Verification (SSV) for rewarded ads.
//
// HOW IT WORKS (the secure model — the phone is never trusted):
//   1. In the app, before showing a rewarded ad, you set the "custom data" and
//      "user id" on the ad request (userId = your Huevix user id).
//   2. When the user finishes watching, AdMob's servers make a GET request
//      DIRECTLY to this endpoint (a URL you configure in the AdMob console),
//      with query params including: user_id, custom_data, transaction_id,
//      reward_amount, reward_item, timestamp, key_id, signature.
//   3. We verify the `signature` against AdMob's PUBLIC KEYS. If valid, we grant
//      the reward to that user_id. Because AdMob calls us server-to-server, a
//      hacked client cannot forge rewards.
//
// AdMob SSV docs: https://developers.google.com/admob/android/ssv
// Public keys:    https://gstatic.com/admob/reward/verifier-keys.json
//
// Setup after deploy:
//   AdMob console -> your app -> the rewarded Ad unit -> "Server-side verification"
//   -> set the callback URL to:
//        https://backend.huevix.com/api/v1/ads/admob-ssv
//
// NOTE: the signature covers the query string EXACTLY as sent, up to (but not
// including) "&signature=". We must verify over the raw query, so this handler
// reconstructs it from the original URL.

import crypto from 'node:crypto';
import { asyncHandler } from '../utils/asyncHandler.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { grantAdCallSeconds } from '../services/entitlement.service.js';

const KEYS_URL = 'https://www.gstatic.com/admob/reward/verifier-keys.json';

// Cache AdMob's verifier keys (they rotate rarely). { keyId: pem }
let keyCache = { fetchedAt: 0, keys: {} };
const KEY_TTL_MS = 6 * 60 * 60 * 1000; // 6h

async function getVerifierKeys() {
  const now = Date.now();
  if (now - keyCache.fetchedAt < KEY_TTL_MS && Object.keys(keyCache.keys).length) {
    return keyCache.keys;
  }
  const res = await fetch(KEYS_URL);
  if (!res.ok) throw new Error(`verifier-keys fetch failed: ${res.status}`);
  const json = await res.json();
  const keys = {};
  for (const k of json.keys || []) {
    // Each entry: { keyId, pem, base64 } — pem is a PEM-encoded ECDSA public key.
    keys[String(k.keyId)] = k.pem;
  }
  keyCache = { fetchedAt: now, keys };
  return keys;
}

// Grant one rewarded-ad credit to a specific user id, honoring the daily cap.
// Mirrors grantAdCredit() but keyed by userId (no req.user object here).
async function grantAdCreditByUserId(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, adCreditsGrantedToday: true, adCreditsGrantedDate: true },
  });
  if (!user) return { granted: false, reason: 'USER_NOT_FOUND' };

  const max = config.entitlement?.maxAdCreditsPerDay ?? 3;

  // Reset the daily counter if the stored date isn't today (UTC).
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const storedDate = user.adCreditsGrantedDate ? new Date(user.adCreditsGrantedDate) : null;
  const isNewDay = !storedDate || storedDate.getTime() !== today.getTime();

  if (isNewDay) {
    await prisma.user.update({
      where: { id: userId },
      data: { adCreditsGrantedToday: 0, adCreditsGrantedDate: today },
    });
  }

  const r = await prisma.user.updateMany({
    where: { id: userId, adCreditsGrantedToday: { lt: max } },
    data: {
      adCreditsRemaining: { increment: 1 },
      adCreditsGrantedToday: { increment: 1 },
      adCreditsGrantedDate: today,
    },
  });
  if (r.count === 0) return { granted: false, reason: 'DAILY_AD_LIMIT' };
  return { granted: true };
}

// Dedup store for transaction_id lives in ProcessedPurchase-like fashion; we use
// a lightweight table keyed by the AdMob transaction id to prevent double-grant
// if AdMob retries the callback. Reuses ProcessedPurchase with a prefix.
async function alreadyProcessed(transactionId) {
  if (!transactionId) return false;
  const key = `admob_ssv:${transactionId}`;
  const existing = await prisma.processedPurchase
    .findUnique({
      where: { purchaseToken: key },
    })
    .catch(() => null);
  return !!existing;
}
async function markProcessed(transactionId, userId, rewardItem) {
  const key = `admob_ssv:${transactionId}`;
  try {
    await prisma.processedPurchase.create({
      data: {
        purchaseToken: key,
        productId: rewardItem || 'ad_reward',
        userId,
        orderId: transactionId,
      },
    });
  } catch {
    // unique violation = already processed by a concurrent retry; fine.
  }
}

// GET /ads/admob-ssv?...&signature=...&key_id=...
export const admobSsv = asyncHandler(async (req, res) => {
  // 1) Reconstruct the raw query string that AdMob signed: everything before
  //    "&signature=".
  const fullUrl = req.originalUrl; // e.g. /api/v1/ads/admob-ssv?ad_network=...&signature=...&key_id=...
  const qIndex = fullUrl.indexOf('?');
  const rawQuery = qIndex >= 0 ? fullUrl.slice(qIndex + 1) : '';
  const sigMarker = '&signature=';
  const sigPos = rawQuery.indexOf(sigMarker);
  if (sigPos < 0) return res.status(400).send('missing signature');

  const signedPortion = rawQuery.slice(0, sigPos);
  const afterSig = rawQuery.slice(sigPos + sigMarker.length);
  // signature is followed by &key_id=...
  const sigEnd = afterSig.indexOf('&');
  const signatureB64Url = sigEnd >= 0 ? afterSig.slice(0, sigEnd) : afterSig;

  const params = req.query;
  const keyId = String(params.key_id || '');
  const userId = String(params.user_id || ''); // set by the app on the ad request
  const transactionId = String(params.transaction_id || '');
  const rewardItem = String(params.reward_item || '');
  const customData = String(params.custom_data || ''); // set by the app: 'call' | '' (speaking)

  if (!keyId || !signatureB64Url) return res.status(400).send('bad request');

  // 2) Verify signature with AdMob's public key (ECDSA over SHA-256).
  let keys;
  try {
    keys = await getVerifierKeys();
  } catch {
    return res.status(500).send('key fetch failed');
  }
  const pem = keys[keyId];
  if (!pem) return res.status(400).send('unknown key_id');

  // AdMob signature is base64url; convert to a Buffer.
  const signature = Buffer.from(signatureB64Url.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

  const verifier = crypto.createVerify('SHA256');
  verifier.update(signedPortion);
  verifier.end();

  let valid = false;
  try {
    // AdMob uses ECDSA; the PEM is an EC public key. Node accepts DER/IEEE-P1363
    // via dsaEncoding. AdMob signatures are IEEE-P1363 (r||s) base64url.
    valid = verifier.verify({ key: pem, dsaEncoding: 'ieee-p1363' }, signature);
  } catch {
    valid = false;
  }

  if (!valid) return res.status(403).send('invalid signature');

  // 3) Grant (idempotently). Respond 200 quickly so AdMob doesn't retry.
  if (!userId) return res.status(200).send('ok'); // nothing to grant, but signature was valid

  if (await alreadyProcessed(transactionId)) {
    return res.status(200).send('ok');
  }
  // Route the grant by the app-declared placement: the Talk tab requests
  // 'call' (free call minutes); everything else stays a speaking credit.
  const result =
    customData === 'call' ? await grantAdCallSeconds(userId) : await grantAdCreditByUserId(userId);
  if (result.granted) {
    await markProcessed(
      transactionId,
      userId,
      customData === 'call' ? 'ad_call_minutes' : rewardItem
    );
  }
  // Always 200 to AdMob on a validly-signed callback (even if capped), so it
  // doesn't keep retrying.
  return res.status(200).send('ok');
});
