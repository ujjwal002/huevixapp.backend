import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { config } from '../src/config/env.js';
import {
  planAmountInr,
  planPeriodEnd,
  verifyPaymentSignature,
} from '../src/services/payment.service.js';

// Snapshot the config fields these tests mutate, and restore after each test.
// (The service reads config at call time, so flipping mockExternal/keySecret
// here exercises the real signature path without re-importing the module.)
const original = {
  mockExternal: config.mockExternal,
  keySecret: config.razorpay.keySecret,
  monthlyInr: config.pricing.monthlyInr,
  yearlyInr: config.pricing.yearlyInr,
};

afterEach(() => {
  config.mockExternal = original.mockExternal;
  config.razorpay.keySecret = original.keySecret;
  config.pricing.monthlyInr = original.monthlyInr;
  config.pricing.yearlyInr = original.yearlyInr;
});

describe('planAmountInr', () => {
  it('returns the configured monthly/yearly price', () => {
    config.pricing.monthlyInr = 100;
    config.pricing.yearlyInr = 999;
    expect(planAmountInr('MONTHLY')).toBe(100);
    expect(planAmountInr('YEARLY')).toBe(999);
  });
});

describe('planPeriodEnd', () => {
  it('adds one month for MONTHLY', () => {
    const end = planPeriodEnd('MONTHLY', new Date('2026-01-15T00:00:00Z'));
    expect(end.toISOString().slice(0, 10)).toBe('2026-02-15');
  });
  it('adds one year for YEARLY', () => {
    const end = planPeriodEnd('YEARLY', new Date('2026-01-15T00:00:00Z'));
    expect(end.toISOString().slice(0, 10)).toBe('2027-01-15');
  });
});

describe('verifyPaymentSignature', () => {
  it('accepts unconditionally in mock mode', () => {
    config.mockExternal = true;
    expect(verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: 'whatever' })).toBe(
      true
    );
  });

  it('FAILS CLOSED in real mode when no secret is configured', () => {
    // Regression guard: this exact combination (real mode + missing Razorpay
    // keys, i.e. any Google-Play-only deployment) used to return true and made
    // /subscription/verify a free-premium endpoint.
    config.mockExternal = false;
    config.razorpay.keySecret = undefined;
    expect(verifyPaymentSignature({ orderId: 'o', paymentId: 'p', signature: 'x' })).toBe(false);
  });

  it('validates a correct HMAC and rejects a forged one in real mode', () => {
    config.mockExternal = false;
    config.razorpay.keySecret = 'test_secret';
    const orderId = 'order_123';
    const paymentId = 'pay_456';
    const good = crypto
      .createHmac('sha256', 'test_secret')
      .update(`${orderId}|${paymentId}`)
      .digest('hex');

    expect(verifyPaymentSignature({ orderId, paymentId, signature: good })).toBe(true);
    expect(verifyPaymentSignature({ orderId, paymentId, signature: 'deadbeef' })).toBe(false);
  });
});
