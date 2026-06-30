import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { addCallSeconds } from '../services/entitlement.service.js';
import * as gp from '../services/googlePlay.service.js';

// =============================================================================
// Google Play purchase verification endpoints (sit alongside the Razorpay flow
// in subscription.controller.js). Three handlers:
//
//   verifyGoogleSubscription  POST /subscription/google/verify     (auth)
//   verifyGoogleProduct       POST /purchases/google/verify        (auth)
//   googleRtdn                POST /google/rtdn/:secret            (no auth, secret)
//
// Design choices that match your existing code:
//   * The client sends only { productId, purchaseToken }; we verify server-side.
//   * Subscriptions reuse your Subscription model (provider='google_play',
//     providerRefId = purchaseToken). isSubscriptionActive() already gates
//     access on status==='ACTIVE' && currentPeriodEnd > now, so nothing in
//     entitlement.service.js needs to change.
//   * One-time packs reuse addCallSeconds() to credit the prepaid balance.
//   * Idempotency: one-time grants are guarded by the ProcessedPurchase table
//     (unique purchaseToken); RTDN messages by ProcessedWebhookEvent (same
//     table the Razorpay webhook uses), keyed by the Pub/Sub messageId.
// =============================================================================

function planForProduct(productId) {
  if (productId === config.googlePlay.subYearlyId) return 'YEARLY';
  if (productId === config.googlePlay.subMonthlyId) return 'MONTHLY';
  return null;
}

// ---- POST /subscription/google/verify --------------------------------------
// Client calls this right after expo-iap reports a successful subscription
// purchase. We confirm with Google, then activate the local subscription.
export const verifyGoogleSubscription = asyncHandler(async (req, res) => {
  const { productId, purchaseToken } = req.body;
  const plan = planForProduct(productId);
  if (!plan) throw ApiError.badRequest('Unknown subscription product', 'UNKNOWN_PRODUCT');

  const sub = await gp.getSubscription(purchaseToken);

  if (!gp.isSubActiveState(sub.subscriptionState)) {
    throw ApiError.badRequest(`Subscription not active (${sub.subscriptionState})`, 'SUB_NOT_ACTIVE');
  }
  const currentPeriodEnd = gp.subscriptionExpiry(sub);
  if (!currentPeriodEnd) throw ApiError.badRequest('Subscription has no expiry', 'NO_EXPIRY');

  const updated = await prisma.subscription.upsert({
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
  const { productId, purchaseToken } = req.body;
  const seconds = config.googlePlay.creditPacks[productId];
  if (!seconds) throw ApiError.badRequest('Unknown product', 'UNKNOWN_PRODUCT');

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
        data: { callSecondsBalance: { increment: seconds } },
        select: { callSecondsBalance: true },
      });
      return u.callSecondsBalance;
    });
  } catch (e) {
    if (e?.code === 'P2002') {
      const u = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { callSecondsBalance: true },
      });
      return res.json({ success: true, duplicate: true, balanceSeconds: u?.callSecondsBalance ?? 0 });
    }
    throw e;
  }

  // Consume so the SKU can be purchased again. (For a permanent unlock you'd
  // call gp.acknowledgeProduct instead and set a flag on the user.)
  await gp.consumeProduct(productId, purchaseToken);

  res.json({ success: true, creditedSeconds: seconds, balanceSeconds: balance });
});

// ---- POST /google/rtdn/:secret ---------------------------------------------
// Real-time Developer Notifications, delivered by Cloud Pub/Sub push. This is
// the Google equivalent of your Razorpay webhook: the source of truth for
// renewals, cancellations, expiries and refunds. We re-query Google for the
// authoritative state rather than trusting the notification body.
//
// Auth: the secret in the URL must match GOOGLE_RTDN_SECRET. (For stronger
// security you can additionally verify the Pub/Sub OIDC token — see the guide.)
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

  // Idempotency: reuse ProcessedWebhookEvent, namespaced so it can't collide
  // with Razorpay event ids. A duplicate push (Pub/Sub guarantees at-least-once)
  // hits the unique constraint and is acked without reprocessing.
  const dedupeId = `gp_${message.messageId}`;
  try {
    await prisma.processedWebhookEvent.create({
      data: { id: dedupeId, eventType: 'google_rtdn' },
    });
  } catch (e) {
    if (e?.code === 'P2002') return res.status(204).end();
    throw e;
  }

  try {
    if (note.subscriptionNotification) {
      await handleSubscriptionNotification(note.subscriptionNotification);
    } else if (note.voidedPurchaseNotification) {
      await handleVoidedPurchase(note.voidedPurchaseNotification);
    }
    // oneTimeProductNotification: nothing to do here — the credit is granted at
    // /purchases/google/verify time and refunds arrive as voidedPurchase events.
  } catch (err) {
    // Roll back the dedupe marker so Pub/Sub retries a genuinely failed event.
    await prisma.processedWebhookEvent.delete({ where: { id: dedupeId } }).catch(() => {});
    console.error('[rtdn] handler error:', err.message);
    return res.status(500).json({ error: 'RTDN_PROCESSING_FAILED' });
  }

  return res.status(204).end();
});

async function handleSubscriptionNotification({ purchaseToken }) {
  if (!purchaseToken) return;
  const sub = await gp.getSubscription(purchaseToken); // authoritative re-fetch

  const local = await prisma.subscription.findFirst({ where: { providerRefId: purchaseToken } });
  if (!local) return; // we don't know this token (e.g. verify never ran) — ignore

  if (gp.isSubActiveState(sub.subscriptionState)) {
    const end = gp.subscriptionExpiry(sub);
    await prisma.subscription.update({
      where: { id: local.id },
      data: { status: 'ACTIVE', currentPeriodEnd: end },
    });
  } else {
    // CANCELED / EXPIRED / ON_HOLD / PAUSED / REVOKED → no access.
    await prisma.subscription.update({
      where: { id: local.id },
      data: { status: 'EXPIRED' },
    });
  }
}

async function handleVoidedPurchase({ purchaseToken }) {
  if (!purchaseToken) return;

  // A voided purchase can be either a subscription or a one-time pack; we look
  // it up in both places rather than branching on the notification's type.
  const local = await prisma.subscription.findFirst({ where: { providerRefId: purchaseToken } });
  if (local) {
    await prisma.subscription.update({
      where: { id: local.id },
      data: { status: 'CANCELED', currentPeriodEnd: null },
    });
    return;
  }

  // One-time pack refund/chargeback: claw back the granted credit (floored at 0).
  const processed = await prisma.processedPurchase.findUnique({ where: { purchaseToken } });
  if (processed) {
    const seconds = config.googlePlay.creditPacks[processed.productId] || 0;
    if (seconds > 0) {
      const u = await prisma.user.findUnique({
        where: { id: processed.userId },
        select: { callSecondsBalance: true },
      });
      const newBalance = Math.max(0, (u?.callSecondsBalance ?? 0) - seconds);
      await prisma.user.update({
        where: { id: processed.userId },
        data: { callSecondsBalance: newBalance },
      });
    }
  }
}