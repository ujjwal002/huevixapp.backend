import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import {
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  planPeriodEnd,
  planAmountInr,
  createRecurringSubscription,
  verifySubscriptionSignature,
  cancelRecurringSubscription,
} from '../services/payment.service.js';

import * as gpurchase from '../controllers/googlePurchase.controller.js';

// GET /subscription
export const getSubscription = asyncHandler(async (req, res) => {
  const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });
  res.json({ subscription: sub });
});

// POST /subscription/checkout  -> create a Razorpay order for the client
export const checkout = asyncHandler(async (req, res) => {
  const { plan } = req.body;
  const order = await createOrder({ plan, userId: req.user.id });

  // Record a PENDING subscription tied to this order.
  await prisma.subscription.upsert({
    where: { userId: req.user.id },
    create: {
      userId: req.user.id,
      plan,
      status: 'PENDING',
      provider: 'razorpay',
      providerOrderId: order.orderId,
    },
    update: { plan, status: 'PENDING', providerOrderId: order.orderId },
  });

  res.json({
    order,
    plan,
    amountInr: planAmountInr(plan),
  });
});

// POST /subscription/verify -> client returns the signed payment; we activate.
export const verify = asyncHandler(async (req, res) => {
  const { orderId, paymentId, signature } = req.body;

  const ok = verifyPaymentSignature({ orderId, paymentId, signature });
  if (!ok) throw ApiError.badRequest('Payment signature verification failed', 'BAD_SIGNATURE');

  const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });
  if (!sub || sub.providerOrderId !== orderId) {
    throw ApiError.badRequest('No matching pending order for this user', 'ORDER_MISMATCH');
  }

  const currentPeriodEnd = planPeriodEnd(sub.plan);
  const updated = await prisma.subscription.update({
    where: { userId: req.user.id },
    data: {
      status: 'ACTIVE',
      providerRefId: paymentId,
      currentPeriodEnd,
    },
  });

  res.json({ success: true, subscription: updated });
});

// Extend a period end without ever shortening it: renew from the later of
// "now" and the current period end so duplicate/early renewals don't lose time.
function extendedPeriodEnd(plan, currentPeriodEnd) {
  const base =
    currentPeriodEnd && new Date(currentPeriodEnd) > new Date()
      ? new Date(currentPeriodEnd)
      : new Date();
  return planPeriodEnd(plan, base);
}

// POST /subscription/webhook -> source of truth for renewals/refunds.
// Mounted with a raw body parser so signature verification works.
export const webhook = asyncHandler(async (req, res) => {
  const signature = req.headers['x-razorpay-signature'];
  const rawBody = req.rawBody || JSON.stringify(req.body);

  if (!verifyWebhookSignature(rawBody, signature)) {
    throw ApiError.badRequest('Invalid webhook signature', 'BAD_WEBHOOK');
  }

  const event = req.body?.event;
  const payload = req.body?.payload;
  const eventId = req.headers['x-razorpay-event-id'];

  // Fix #9 (hardened): idempotency + side effects in ONE transaction. We record
  // the provider event id and apply its effects atomically, so a crash between
  // "marked handled" and "effect applied" can't permanently drop an event — if
  // anything fails, the whole unit rolls back (marker included) and the
  // provider's retry reprocesses cleanly. A duplicate delivery hits the unique
  // constraint (P2002) and is acknowledged without reprocessing.
  try {
    await prisma.$transaction(async (tx) => {
      if (eventId) {
        await tx.processedWebhookEvent.create({
          data: { id: String(eventId), eventType: event || 'unknown' },
        });
      }

      switch (event) {
        case 'payment.captured': {
          const orderId = payload?.payment?.entity?.order_id;
          if (orderId) {
            const sub = await tx.subscription.findFirst({ where: { providerOrderId: orderId } });
            if (sub && sub.status !== 'ACTIVE') {
              await tx.subscription.update({
                where: { id: sub.id },
                data: { status: 'ACTIVE', currentPeriodEnd: planPeriodEnd(sub.plan) },
              });
            }
          }
          break;
        }

        case 'subscription.charged': {
          const subId = payload?.subscription?.entity?.id;
          if (subId) {
            const s = await tx.subscription.findFirst({ where: { providerRefId: subId } });
            if (s) {
              await tx.subscription.update({
                where: { id: s.id },
                data: { status: 'ACTIVE', currentPeriodEnd: extendedPeriodEnd(s.plan, s.currentPeriodEnd) },
              });
            }
          }
          break;
        }

        case 'subscription.cancelled':
        case 'subscription.halted':
        case 'subscription.completed': {
          const subId = payload?.subscription?.entity?.id;
          if (subId) {
            await tx.subscription.updateMany({
              where: { providerRefId: subId },
              data: { status: 'CANCELED' },
            });
          }
          break;
        }

        case 'refund.processed': {
          const orderId = payload?.payment?.entity?.order_id;
          if (orderId) {
            await tx.subscription.updateMany({
              where: { providerOrderId: orderId },
              data: { status: 'CANCELED' },
            });
          }
          break;
        }

        default:
          break; // event we don't act on
      }
    });
  } catch (err) {
    // Duplicate delivery: the marker insert hit the unique constraint. The
    // event was already handled, so acknowledge and stop the retries.
    if (err?.code === 'P2002') {
      return res.json({ received: true, duplicate: true });
    }
    // Genuine failure: the transaction rolled back (marker + effects), so it's
    // safe to ask Razorpay to retry by returning a 5xx.
    console.error('[WEBHOOK] handler error', err.message);
    return res.status(500).json({ received: false, error: 'WEBHOOK_PROCESSING_FAILED' });
  }

  // Acknowledge so the provider stops retrying a successfully-handled event.
  res.json({ received: true });
});

export const startAutopay = asyncHandler(async (req, res) => {
  const planId = config.razorpay.planMonthly;
  if (!planId) throw ApiError.badRequest('Monthly plan not configured (RAZORPAY_PLAN_MONTHLY)', 'NO_PLAN');
  const { subscriptionId, keyId } = await createRecurringSubscription({ planId, userId: req.user.id });
  await prisma.subscription.upsert({
    where: { userId: req.user.id },
    create: { userId: req.user.id, plan: 'MONTHLY', status: 'PENDING', provider: 'razorpay', providerRefId: subscriptionId },
    update: { plan: 'MONTHLY', status: 'PENDING', providerRefId: subscriptionId },
  });
  res.json({ subscriptionId, keyId, plan: 'MONTHLY' });
});

export const verifyAutopay = asyncHandler(async (req, res) => {
  const { subscriptionId, paymentId, signature } = req.body;
  if (!verifySubscriptionSignature({ subscriptionId, paymentId, signature })) {
    throw ApiError.badRequest('Signature verification failed', 'BAD_SIGNATURE');
  }
  const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });
  if (!sub || sub.providerRefId !== subscriptionId) throw ApiError.badRequest('No matching subscription', 'MISMATCH');
  const updated = await prisma.subscription.update({
    where: { userId: req.user.id },
    data: { status: 'ACTIVE', currentPeriodEnd: planPeriodEnd('MONTHLY') },
  });
  res.json({ success: true, subscription: updated });
});

export const cancelSubscription = asyncHandler(async (req, res) => {
  const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });
  if (!sub) return res.json({ success: true, subscription: null });
  if (sub.providerRefId) await cancelRecurringSubscription(sub.providerRefId); // stop future autopay charges
  const updated = await prisma.subscription.update({
    where: { userId: req.user.id },
    data: { status: 'CANCELED', currentPeriodEnd: null },
  });
  res.json({ success: true, subscription: updated });
});