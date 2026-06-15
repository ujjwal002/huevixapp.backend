import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import {
  createOrder,
  verifyPaymentSignature,
  verifyWebhookSignature,
  planPeriodEnd,
  planAmountInr,
} from '../services/payment.service.js';

import { cancelRecurringSubscription } from '../services/payment.service.js';



import { config } from '../config/env.js';
import { createRecurringSubscription, verifySubscriptionSignature } from '../services/payment.service.js';

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

  // Handle the events you care about. Example: payment captured / refunded.
  try {
    if (event === 'payment.captured') {
      const orderId = payload?.payment?.entity?.order_id;
      if (orderId) {
        const sub = await prisma.subscription.findFirst({ where: { providerOrderId: orderId } });
        if (sub && sub.status !== 'ACTIVE') {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { status: 'ACTIVE', currentPeriodEnd: planPeriodEnd(sub.plan) },
          });
        }
      }
    } 
    if (event === 'subscription.charged') {
      const subId = payload?.subscription?.entity?.id;
      if (subId) {
        const s = await prisma.subscription.findFirst({ where: { providerRefId: subId } });
        if (s) await prisma.subscription.update({ where: { id: s.id }, data: { status: 'ACTIVE', currentPeriodEnd: planPeriodEnd(s.plan, new Date()) } });
      }
    } else if (['subscription.cancelled', 'subscription.halted', 'subscription.completed'].includes(event)) {
      const subId = payload?.subscription?.entity?.id;
      if (subId) await prisma.subscription.updateMany({ where: { providerRefId: subId }, data: { status: 'CANCELED' } });
    }
    else if (event === 'refund.processed' || event === 'subscription.cancelled') {
      const orderId = payload?.payment?.entity?.order_id;
      if (orderId) {
        await prisma.subscription.updateMany({
          where: { providerOrderId: orderId },
          data: { status: 'CANCELED' },
        });
      }
    }
  } catch (err) {
    console.error('[WEBHOOK] handler error', err.message);
  }

  // Always 200 quickly so the provider stops retrying.
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
