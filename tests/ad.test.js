import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { config } from '../src/config/env.js';
import { verifyAdReward } from '../src/services/ad.service.js';

const original = { mockExternal: config.mockExternal, rewardSecret: config.ads.rewardSecret };

afterEach(() => {
  config.mockExternal = original.mockExternal;
  config.ads.rewardSecret = original.rewardSecret;
});

const sign = (secret, token) => crypto.createHmac('sha256', secret).update(token).digest('hex');

describe('verifyAdReward', () => {
  it('accepts anything in mock mode (frictionless dev/demo)', () => {
    config.mockExternal = true;
    expect(verifyAdReward({}).ok).toBe(true);
  });

  it('FAILS CLOSED in real mode when no secret is configured', () => {
    config.mockExternal = false;
    config.ads.rewardSecret = null;
    expect(verifyAdReward({ token: 't', signature: 's' })).toMatchObject({
      ok: false,
      reason: 'AD_VERIFICATION_UNCONFIGURED',
    });
  });

  it('rejects a missing token/signature in real mode', () => {
    config.mockExternal = false;
    config.ads.rewardSecret = 'secret';
    expect(verifyAdReward({}).reason).toBe('AD_TOKEN_MISSING');
  });

  it('accepts a correctly-signed token and rejects a forged signature', () => {
    config.mockExternal = false;
    config.ads.rewardSecret = 'secret';
    const token = 'txn_abc';
    expect(verifyAdReward({ token, signature: sign('secret', token) }).ok).toBe(true);
    expect(verifyAdReward({ token, signature: 'forged' })).toMatchObject({
      ok: false,
      reason: 'AD_SIGNATURE_INVALID',
    });
  });

  it('rejects a stale token whose embedded timestamp is outside the replay window', () => {
    config.mockExternal = false;
    config.ads.rewardSecret = 'secret';
    const staleUnix = Math.floor(Date.now() / 1000) - 3600; // 1 hour ago (> 10 min)
    const token = `txn_abc.${staleUnix}`;
    expect(verifyAdReward({ token, signature: sign('secret', token) })).toMatchObject({
      ok: false,
      reason: 'AD_TOKEN_EXPIRED',
    });
  });

  it('accepts a fresh timestamped token', () => {
    config.mockExternal = false;
    config.ads.rewardSecret = 'secret';
    const freshUnix = Math.floor(Date.now() / 1000) - 5; // 5 seconds ago
    const token = `txn_abc.${freshUnix}`;
    expect(verifyAdReward({ token, signature: sign('secret', token) }).ok).toBe(true);
  });
});