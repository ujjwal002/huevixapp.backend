import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import * as gp from '../services/googlePlay.service.js';

// =============================================================================
// Google Play purchase verification — the ONLY payment path since the Razorpay
// migration. Three handlers:
//
//   verifyGoogleSubscription  POST /subscription/google/verify     (auth)
//   verifyGoogleProduct       POST /purchases/google/verify        (auth)
//   googleRtdn                POST /google/rtdn/:secret            (no auth, secret)
//
// Anti-abuse model:
//   * The client sends only { productId, purchaseToken }; entitlement is
//     decided exclusively from Google's answer, never the client's claim.
//   * TOKEN CLAIMING: a purchaseToken can activate exactly ONE account. The
//     unique index on Subscription.providerRefId is the DB backstop; the
//     explicit ownership check below gives a clean error instead of a P2002.
//   * PRODUCT ASSERTION: the client's productId must match the lineItems in
//     Google's response, so a monthly buyer can't record a YEARLY plan.
//   * ACCOUNT BINDING: if the app sets obfuscatedExternalAccountId = userId at
//     purchase time (recommended!), we verify it matches the caller, and RTDN
//     can grant purchases even when the client never reached /verify.
//   * Idempotency: one-time grants via ProcessedPurchase (unique token); RTDN
//     via ProcessedWebhookEvent keyed by the Pub/Sub messageId, with the
//     marker + effects committed in ONE transaction (crash-safe, like the old
//     Razorpay webhook).
// =============================================================================

function planForProduct(productId) {
  if (productId === config.googlePlay.subYearlyId) return 'YEARLY';
  if (productId === config.googlePlay.subMonthlyId) return 'MONTHLY';
  return null;
}

// The productId(s) Google says this token is for. subscriptionsv2 puts them on
// lineItems; there is normally exactly one.
function productIdsOf(sub) {
  return (sub.lineItems || []).map((li) => li.productId).filter(Boolean);
}

// The userId the app embedded at purchase time (if it did). Two shapes exist in
// the wild depending on API version, so check both.
function boundUserIdOf(sub) {
  return (
    sub.externalAccountIdentifiers?.obfuscatedExternalAccountId ||
    sub.obfuscatedExternalAccountId ||
    null
  );
}

// Local subscription state for a Google subscriptionsv2 resource.
//   ACTIVE / IN_GRACE_PERIOD -> ACTIVE   (paid & entitled)
//   CANCELED                 -> CANCELED (auto-renew OFF but still INSIDE the
//                                        paid period: entitled until expiry —
//                                        do NOT revoke access here)
//   everything else          -> EXPIRED  (on hold, paused, expired, revoked)
function localStateFor(sub) {
  const state = sub.subscriptionState;
  if (gp.isSubActiveState(state)) return 'ACTIVE';
  if (state === 'SUBSCRIPTION_STATE_CANCELED') return 'CANCELED';
  return 'EXPIRED';
}

// Apply Google's authoritative subscription state to a local row (tx-aware).
async function applyGoogleState(tx, localId, sub) {
  const status = localStateFor(sub);
  const end = gp.subscriptionExpiry(sub);
  await tx.subscription.update({
    where: { id: localId },
    data:
      status === 'EXPIRED'
        ? { status, currentPeriodEnd: null }
        : { status, ...(end ? { currentPeriodEnd: end } : {}) },
  });
}

// ---- POST /subscription/google/verify --------------------------------------
// Client calls this right after expo-iap reports a successful subscription
// purchase. We confirm with Google, then activate the local subscription.
export const verifyGoogleSubscription = asyncHandler(async (req, res) => {
  const { productId, purchaseToken } = req.body || {};
  if (!purchaseToken || typeof purchaseToken !== 'string') {
    throw ApiError.badRequest('purchaseToken is required', 'MISSING_TOKEN');
  }
  const plan = planForProduct(productId);
  if (!plan) throw ApiError.badRequest('Unknown subscription product', 'UNKNOWN_PRODUCT');

  const sub = await gp.getSubscription(purchaseToken);

  if (!gp.isSubActiveState(sub.subscriptionState)) {
    throw ApiError.badRequest(`Subscription not active (${sub.subscriptionState})`, 'SUB_NOT_ACTIVE');
  }
  const currentPeriodEnd = gp.subscriptionExpiry(sub);
  if (!currentPeriodEnd) throw ApiError.badRequest('Subscription has no expiry', 'NO_EXPIRY');

  // PRODUCT ASSERTION: the plan we store must come from what Google says was
  // bought, not from the client's claim. (Mock mode fabricates the monthly SKU,
  // so this also passes locally.)
  const googleProducts = productIdsOf(sub);
  if (googleProducts.length && !googleProducts.includes(productId)) {
    throw ApiError.badRequest('Product does not match the purchase token', 'PRODUCT_MISMATCH');
  }

  // ACCOUNT BINDING: if the purchase carries an embedded userId, it must be the
  // caller. Set obfuscatedExternalAccountId = user.id in the app's billing flow
  // to turn this on; purchases without it still pass (backwards compatible).
  const boundUserId = boundUserIdOf(sub);
  if (boundUserId && boundUserId !== req.user.id) {
    throw ApiError.forbidden('This purchase belongs to a different account', 'TOKEN_NOT_YOURS');
  }

  // TOKEN CLAIMING: reject a token already attached to someone else's
  // subscription. The unique index on providerRefId closes the race two
  // concurrent claims could otherwise win together.
  const claimedBy = await prisma.subscription.findFirst({
    where: { providerRefId: purchaseToken, userId: { not: req.user.id } },
    select: { id: true },
  });
  if (claimedBy) {
    throw ApiError.forbidden('This purchase is already linked to another account', 'TOKEN_ALREADY_USED');
  }

  let updated;
  try {
    updated = await prisma.subscription.upsert({
      where: { userId: req.user.id },
      create: {
        userId: req.user.id,
        plan,
        status: 'ACTIVE',
        provider: 'google_play',
        providerRefId: purchaseToken, // long-lived; RTDN re-queries with this
        currentPeriodEnd,
      },
      update: {
        plan,
        status: 'ACTIVE',
        provider: 'google_play',
        providerRefId: purchaseToken,
        currentPeriodEnd,
      },
    });
  } catch (e) {
    // Lost the claim race: someone else's row grabbed this token between our
    // check and the upsert. Same outcome as the explicit check above.
    if (e?.code === 'P2002') {
      throw ApiError.forbidden('This purchase is already linked to another account', 'TOKEN_ALREADY_USED');
    }
    throw e;
  }

  // Acknowledge within 3 days or Google auto-refunds. Safe to call even if the
  // client's finishTransaction already acknowledged.
  if (sub.acknowledgementState !== 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED') {
    await gp.acknowledgeSubscription(productId, purchaseToken);
  }

  res.json({ success: true, subscription: updated });
});

// ---- POST /purchases/google/verify -----------------------------------------
// One-time CONSUMABLE credit packs (maps productId -> seconds of call credit).
export const verifyGoogleProduct = asyncHandler(async (req, res) => {
  const { productId, purchaseToken } = req.body || {};
  if (!purchaseToken || typeof purchaseToken !== 'string') {
    throw ApiError.badRequest('purchaseToken is required', 'MISSING_TOKEN');
  }
  const coins = config.googlePlay.creditPacks[productId]; // value is COINS
  if (!coins) throw ApiError.badRequest('Unknown product', 'UNKNOWN_PRODUCT');

  const product = await gp.getProduct(productId, purchaseToken);
  if (product.purchaseState !== gp.PRODUCT_PURCHASED) {
    throw ApiError.badRequest('Purchase not completed', 'NOT_PURCHASED');
  }

  // Grant exactly once. The unique purchaseToken makes a replayed request (or a
  // client retry) a no-op: the second insert hits P2002 and we skip the credit.
  let balance;
  try {
    balance = await prisma.$transaction(async (tx) => {
      await tx.processedPurchase.create({
        data: {
          purchaseToken,
          productId,
          userId: req.user.id,
          orderId: product.orderId || null,
        },
      });
      const u = await tx.user.update({
        where: { id: req.user.id },
        data: { coinBalance: { increment: coins } },
        select: { coinBalance: true },
      });
      return u.coinBalance;
    });
  } catch (e) {
    if (e?.code === 'P2002') {
      const u = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { coinBalance: true },
      });
      return res.json({ success: true, duplicate: true, coinBalance: u?.coinBalance ?? 0 });
    }
    throw e;
  }

  // Consume so the SKU can be purchased again. (For a permanent unlock you'd
  // call gp.acknowledgeProduct instead and set a flag on the user.)
  await gp.consumeProduct(productId, purchaseToken);

  res.json({ success: true, creditedCoins: coins, coinBalance: balance });
});

// ---- POST /google/rtdn/:secret ---------------------------------------------
// Real-time Developer Notifications, delivered by Cloud Pub/Sub push — the
// source of truth for renewals, cancellations, expiries and refunds. We
// re-query Google for the authoritative state rather than trusting the
// notification body.
//
// Auth: the secret in the URL must match GOOGLE_RTDN_SECRET. (For stronger
// security, additionally verify the Pub/Sub OIDC token.)
//
// Idempotency + crash-safety: the dedupe marker and all DB effects commit in
// ONE transaction. A crash mid-processing rolls back the marker too, so
// Pub/Sub's retry reprocesses cleanly; a duplicate delivery hits the unique
// constraint and is acked without side effects. (The Google re-query happens
// BEFORE the transaction so we never hold a DB tx open across a network call.)
export const googleRtdn = asyncHandler(async (req, res) => {
  const expected = config.googlePlay.rtdnSecret || '';
  const got = req.params.secret || '';
  if (
    !expected ||
    got.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))
  ) {
    throw ApiError.unauthorized('Bad RTDN secret', 'BAD_RTDN_SECRET');
  }

  // Pub/Sub push envelope: { message: { data (base64), messageId }, subscription }
  const message = req.body?.message;
  if (!message?.data) return res.status(204).end(); // nothing to do; ack

  let note;
  try {
    note = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  } catch {
    return res.status(204).end(); // malformed; ack so Pub/Sub stops retrying
  }

  const dedupeId = `gp_${message.messageId}`;

  // Fast path: already handled (cheap read; the unique constraint inside the
  // transaction below remains the authoritative guard).
  const seen = await prisma.processedWebhookEvent.findUnique({ where: { id: dedupeId } });
  if (seen) return res.status(204).end();

  // ---- Pre-fetch authoritative state OUTSIDE the transaction ----------------
  let work = null; // () => tx-effects, decided below

  if (note.subscriptionNotification?.purchaseToken) {
    const purchaseToken = note.subscriptionNotification.purchaseToken;
    let sub;
    try {
      sub = await gp.getSubscription(purchaseToken);
    } catch (err) {
      // Couldn't reach Google: 5xx so Pub/Sub retries later (marker not written).
      console.error('[rtdn] google re-query failed:', err.message);
      return res.status(502).json({ error: 'GP_QUERY_FAILED' });
    }

    const local = await prisma.subscription.findFirst({
      where: { providerRefId: purchaseToken },
      select: { id: true },
    });

    if (local) {
      work = (tx) => applyGoogleState(tx, local.id, sub);
    } else {
      // Unknown token: the client died before calling /verify. If the purchase
      // is bound to a user (obfuscatedExternalAccountId), grant it here so a
      // paid user is never left without access. Unbound + unknown -> ignore
      // (we have no safe way to pick an account).
      const boundUserId = boundUserIdOf(sub);
      const googleProducts = productIdsOf(sub);
      const plan = planForProduct(googleProducts[0]);
      const end = gp.subscriptionExpiry(sub);
      const entitled = localStateFor(sub) !== 'EXPIRED';
      if (boundUserId && plan && end && entitled) {
        const userExists = await prisma.user.findUnique({
          where: { id: boundUserId },
          select: { id: true },
        });
        if (userExists) {
          work = (tx) =>
            tx.subscription.upsert({
              where: { userId: boundUserId },
              create: {
                userId: boundUserId,
                plan,
                status: localStateFor(sub),
                provider: 'google_play',
                providerRefId: purchaseToken,
                currentPeriodEnd: end,
              },
              update: {
                plan,
                status: localStateFor(sub),
                provider: 'google_play',
                providerRefId: purchaseToken,
                currentPeriodEnd: end,
              },
            });
        }
      }
      if (!work) {
        console.warn('[rtdn] unknown purchase token (no bound user) — recording as seen');
      }
    }
  } else if (note.voidedPurchaseNotification?.purchaseToken) {
    const { purchaseToken } = note.voidedPurchaseNotification;
    work = (tx) => handleVoidedPurchase(tx, purchaseToken);
  }
  // oneTimeProductNotification: nothing to do — the credit is granted at
  // /purchases/google/verify time and refunds arrive as voidedPurchase events.

  try {
    await prisma.$transaction(async (tx) => {
      await tx.processedWebhookEvent.create({ data: { id: dedupeId, eventType: 'google_rtdn' } });
      if (work) await work(tx);
    });
  } catch (err) {
    if (err?.code === 'P2002') return res.status(204).end(); // duplicate delivery
    console.error('[rtdn] handler error:', err.message);
    return res.status(500).json({ error: 'RTDN_PROCESSING_FAILED' }); // tx rolled back; retry
  }

  return res.status(204).end();
});

async function handleVoidedPurchase(tx, purchaseToken) {
  if (!purchaseToken) return;

  // A voided purchase can be either a subscription or a one-time pack; we look
  // it up in both places rather than branching on the notification's type.
  const local = await tx.subscription.findFirst({ where: { providerRefId: purchaseToken } });
  if (local) {
    // Refund/chargeback -> revoke access immediately.
    await tx.subscription.update({
      where: { id: local.id },
      data: { status: 'EXPIRED', currentPeriodEnd: null },
    });
    return;
  }

  // One-time pack refund/chargeback: claw back the granted credit, floored at
  // zero — as a pair of CONDITIONAL updates so a concurrent spend can't
  // interleave between a read and a write.
  const processed = await tx.processedPurchase.findUnique({ where: { purchaseToken } });
  if (processed) {
    const coins = config.googlePlay.creditPacks[processed.productId] || 0;
    if (coins > 0) {
      const r = await tx.user.updateMany({
        where: { id: processed.userId, coinBalance: { gte: coins } },
        data: { coinBalance: { decrement: coins } },
      });
      if (r.count === 0) {
        await tx.user.updateMany({
          where: { id: processed.userId },
          data: { coinBalance: 0 },
        });
      }
    }
  }
}