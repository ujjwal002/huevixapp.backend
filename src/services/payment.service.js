import crypto from 'node:crypto';
import { config } from '../config/env.js';

import { ApiError } from '../utils/ApiError.js';

import { withTimeout } from '../utils/withTimeout.js';
import { timingSafeEqualStr } from '../utils/crypto.js';

// Razorpay is the standard payment gateway for India. In mock mode we fabricate
// order ids and accept any signature so you can test the subscription flow
// end-to-end without a Razorpay account.

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

  if (config.mockExternal) {
    return {
      orderId: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
      amount: amountPaise,
      currency: 'INR',
      keyId: 'rzp_test_mock',
      _mock: true,
    };
  }
  // Real mode but Razorpay not configured: refuse instead of fabricating a mock
  // order (which, combined with a fail-open verify, minted free subscriptions).
  if (!config.razorpay.keyId) {
    throw new ApiError(501, 'Razorpay is not configured on this server', 'RAZORPAY_DISABLED');
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
    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: config.razorpay.keyId,
    };
  } catch (e) {
    console.error('[razorpay] order create failed:', e?.error?.description || e?.message || e);
    throw ApiError.badRequest(
      e?.error?.description || 'Razorpay order creation failed',
      'RAZORPAY_ERROR'
    );
  }
}

// Verifies the checkout signature returned by Razorpay Checkout on the client.
export function verifyPaymentSignature({ orderId, paymentId, signature }) {
  if (config.mockExternal) return true; // accept in mock mode only
  // FAIL CLOSED: real mode with no secret means we CANNOT verify — reject.
  // (Previously returned true, which made /subscription/verify a free-premium
  // endpoint on any deployment that didn't set Razorpay keys.)
  if (!config.razorpay.keySecret) return false;
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${orderId}|${paymentId}`)
    .digest('hex');
  return timingSafeEqualStr(expected, signature);
}

// Verifies a Razorpay webhook payload signature.
export function verifyWebhookSignature(rawBody, signature) {
  if (config.mockExternal) return true;
  if (!config.razorpay.webhookSecret) return false; // fail closed, never fail open
  const expected = crypto
    .createHmac('sha256', config.razorpay.webhookSecret)
    .update(rawBody)
    .digest('hex');
  return timingSafeEqualStr(expected, signature); // Fix #4: constant-time, was plain ===
}

export async function createRecurringSubscription({ planId, userId, totalCount = 120 }) {
  if (config.mockExternal) {
    return { subscriptionId: `sub_mock_${Date.now()}`, keyId: 'rzp_test_mock', _mock: true };
  }
  if (!config.razorpay.keyId) {
    throw new ApiError(501, 'Razorpay is not configured on this server', 'RAZORPAY_DISABLED');
  }
  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
  try {
    const sub = await withTimeout(
      instance.subscriptions.create({
        plan_id: planId,
        total_count: totalCount, // number of monthly cycles (120 ≈ "ongoing")
        customer_notify: 1,
        notes: { userId },
      }),
      { label: 'Razorpay subscription create' }
    );
    return { subscriptionId: sub.id, keyId: config.razorpay.keyId };
  } catch (e) {
    console.error(
      '[razorpay] subscription create failed:',
      e?.error?.description || e?.message || e
    );
    throw ApiError.badRequest(
      e?.error?.description || 'Subscription creation failed',
      'RAZORPAY_ERROR'
    );
  }
}

// Subscription signatures hash payment_id|subscription_id (different order from orders!)
export function verifySubscriptionSignature({ subscriptionId, paymentId, signature }) {
  if (config.mockExternal) return true;
  if (!config.razorpay.keySecret) return false; // fail closed
  const expected = crypto
    .createHmac('sha256', config.razorpay.keySecret)
    .update(`${paymentId}|${subscriptionId}`)
    .digest('hex');
  return timingSafeEqualStr(expected, signature);
}

export async function cancelRecurringSubscription(subscriptionId) {
  if (
    config.mockExternal ||
    !config.razorpay.keyId ||
    !subscriptionId ||
    subscriptionId.includes('mock') ||
    !subscriptionId.startsWith('sub_')
  ) {
    return; // nothing to cancel on Razorpay (one-time order or mock)
  }
  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
  try {
    await withTimeout(instance.subscriptions.cancel(subscriptionId, false), {
      label: 'Razorpay subscription cancel',
    }); // cancel immediately
  } catch (e) {
    console.error('[razorpay] cancel failed:', e?.error?.description || e?.message || e);
    // don't throw — we still cancel locally
  }
}

// One-time order for an arbitrary amount (used by paid startup promos). Unlike
// createOrder (which prices a subscription plan), this takes the amount directly.
export async function createPromoOrder({ amountPaise, userId, promoId }) {
  if (config.mockExternal) {
    return {
      orderId: `order_mock_${crypto.randomBytes(8).toString('hex')}`,
      amount: amountPaise,
      currency: 'INR',
      keyId: 'rzp_test_mock',
      _mock: true,
    };
  }
  if (!config.razorpay.keyId) {
    throw new ApiError(501, 'Razorpay is not configured on this server', 'RAZORPAY_DISABLED');
  }
  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
  try {
    const order = await withTimeout(
      instance.orders.create({
        amount: amountPaise,
        currency: 'INR',
        receipt: `promo_${Date.now()}`,
        notes: { userId, promoId, kind: 'startup_promo' },
      }),
      { label: 'Razorpay promo order create' }
    );
    return {
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: config.razorpay.keyId,
    };
  } catch (e) {
    console.error(
      '[razorpay] promo order create failed:',
      e?.error?.description || e?.message || e
    );
    throw ApiError.badRequest(
      e?.error?.description || 'Razorpay order creation failed',
      'RAZORPAY_ERROR'
    );
  }
}

// Refunds a captured payment (used when an admin rejects a paid promo).
export async function refundPayment(paymentId, amountPaise) {
  if (
    config.mockExternal ||
    !config.razorpay.keyId ||
    !paymentId ||
    String(paymentId).includes('mock')
  ) {
    return { refundId: `rfnd_mock_${crypto.randomBytes(6).toString('hex')}`, _mock: true };
  }
  const { default: Razorpay } = await import('razorpay');
  const instance = new Razorpay({
    key_id: config.razorpay.keyId,
    key_secret: config.razorpay.keySecret,
  });
  try {
    const refund = await withTimeout(instance.payments.refund(paymentId, { amount: amountPaise }), {
      label: 'Razorpay refund',
    });
    return { refundId: refund.id };
  } catch (e) {
    console.error('[razorpay] refund failed:', e?.error?.description || e?.message || e);
    throw ApiError.badRequest(e?.error?.description || 'Refund failed', 'RAZORPAY_ERROR');
  }
}
