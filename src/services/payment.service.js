import crypto from 'node:crypto';
import { config } from '../config/env.js';

import { ApiError } from '../utils/ApiError.js';

// Razorpay is the standard payment gateway for India. In mock mode we fabricate
// order ids and accept any signature so you can test the subscription flow
// end-to-end without a Razorpay account.

// Fix #4: constant-time comparison of two hex digests that also tolerates a
// wrong-length / missing candidate. crypto.timingSafeEqual throws a RangeError
// when buffer lengths differ, which previously turned a malformed signature
// into a 500. We normalise to fixed-length buffers first, then compare in
// constant time.
function safeHexEqual(expectedHex, actualHex) {
  const expected = Buffer.from(String(expectedHex), 'utf8');
  const actual = Buffer.from(String(actualHex || ''), 'utf8');
  if (expected.length !== actual.length) {
    // Still spend the work of a comparison to avoid leaking length via timing.
    crypto.timingSafeEqual(expected, expected);
    return false;
  }
  return crypto.timingSafeEqual(expected, actual);
}

export function planAmountInr(plan) {
  return plan === 'YEARLY' ? config.pricing.yearlyInr : config.pricing.monthlyInr;
}

export function planPeriodEnd(plan, from = new Date()) {
  const end = new Date(from);
  if (plan === 'YEARLY') end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);
  return end;
}

export async function createOrder({ plan, userId }) {
  const amountPaise = planAmountInr(plan) * 100; // Razorpay uses paise

  if (config.mockExternal || !config.razorpay.keyId) {
    return {
      orderId: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
      amount: amountPaise,
      currency: 'INR',
      keyId: 'rzp_test_mock',
      _mock: true,
    };
  }

  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
  try {
    const order = await instance.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `sub_${Date.now()}`, // must stay under Razorpay's 40-char limit
      notes: { userId, plan },
    });
    return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: config.razorpay.keyId };
  } catch (e) {
    console.error('[razorpay] order create failed:', e?.error?.description || e?.message || e);
    throw ApiError.badRequest(e?.error?.description || 'Razorpay order creation failed', 'RAZORPAY_ERROR');
  }
}

// Verifies the checkout signature returned by Razorpay Checkout on the client.
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (config.mockExternal || !config.razorpay.keySecret) {
    return true; // accept in mock mode
  }
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return safeHexEqual(expected, signature);
}

// Verifies a Razorpay webhook payload signature.
export function verifyWebhookSignature(rawBody, signature) {
  if (config.mockExternal || !config.razorpay.webhookSecret) return true;
  const expected = crypto
    .createHmac('sha256', config.razorpay.webhookSecret)
    .update(rawBody)
    .digest('hex');
  return safeHexEqual(expected, signature); // Fix #4: constant-time, was plain ===
}

export async function createRecurringSubscription({ planId, userId, totalCount = 120 }) {
  if (config.mockExternal || !config.razorpay.keyId) {
    return { subscriptionId: `sub_mock_${Date.now()}`, keyId: 'rzp_test_mock', _mock: true };
  }
  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  try {
    const sub = await instance.subscriptions.create({
      plan_id: planId,
      total_count: totalCount,   // number of monthly cycles (120 ≈ "ongoing")
      customer_notify: 1,
      notes: { userId },
    });
    return { subscriptionId: sub.id, keyId: config.razorpay.keyId };
  } catch (e) {
    console.error('[razorpay] subscription create failed:', e?.error?.description || e?.message || e);
    throw ApiError.badRequest(e?.error?.description || 'Subscription creation failed', 'RAZORPAY_ERROR');
  }
}

// Subscription signatures hash payment_id|subscription_id (different order from orders!)
export function verifySubscriptionSignature({ subscriptionId, paymentId, signature }) {
  if (config.mockExternal || !config.razorpay.keySecret) return true;
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
  return safeHexEqual(expected, signature);
}

export async function cancelRecurringSubscription(subscriptionId) {
  if (config.mockExternal || !config.razorpay.keyId || !subscriptionId || subscriptionId.includes('mock') || !subscriptionId.startsWith('sub_')) {
    return; // nothing to cancel on Razorpay (one-time order or mock)
  }
  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  try {
    await instance.subscriptions.cancel(subscriptionId, false); // cancel immediately
  } catch (e) {
    console.error('[razorpay] cancel failed:', e?.error?.description || e?.message || e);
    // don't throw — we still cancel locally
  }
}


// One-time order for an arbitrary amount (used by paid startup promos). Unlike
// createOrder (which prices a subscription plan), this takes the amount directly.
export async function createPromoOrder({ amountPaise, userId, promoId }) {
  if (config.mockExternal || !config.razorpay.keyId) {
    return {
      orderId: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
      amount: amountPaise,
      currency: 'INR',
      keyId: 'rzp_test_mock',
      _mock: true,
    };
  }
  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  try {
    const order = await instance.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: `promo_${Date.now()}`,
      notes: { userId, promoId, kind: 'startup_promo' },
    });
    return { orderId: order.id, amount: order.amount, currency: order.currency, keyId: config.razorpay.keyId };
  } catch (e) {
    console.error('[razorpay] promo order create failed:', e?.error?.description || e?.message || e);
    throw ApiError.badRequest(e?.error?.description || 'Razorpay order creation failed', 'RAZORPAY_ERROR');
  }
}

// Refunds a captured payment (used when an admin rejects a paid promo).
export async function refundPayment(paymentId, amountPaise) {
  if (config.mockExternal || !config.razorpay.keyId || !paymentId || String(paymentId).includes('mock')) {
    return { refundId: `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`, _mock: true };
  }
  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({ key_id: config.razorpay.keyId, key_secret: config.razorpay.keySecret });
  try {
    const refund = await instance.payments.refund(paymentId, { amount: amountPaise });
    return { refundId: refund.id };
  } catch (e) {
    console.error('[razorpay] refund failed:', e?.error?.description || e?.message || e);
    throw ApiError.badRequest(e?.error?.description || 'Refund failed', 'RAZORPAY_ERROR');
  }
}