import { describe, it, expect, afterEach } from 'vitest';
import { config } from '../src/config/env.js';
import { verifyPubSubPushToken } from '../src/services/pubsubAuth.service.js';

// Snapshot the config fields these tests mutate, and restore after each test
// (same pattern as payment.test.js). The service reads config at call time.
const original = {
  rtdnAudience: config.googlePlay.rtdnAudience,
  rtdnServiceAccountEmail: config.googlePlay.rtdnServiceAccountEmail,
};

afterEach(() => {
  config.googlePlay.rtdnAudience = original.rtdnAudience;
  config.googlePlay.rtdnServiceAccountEmail = original.rtdnServiceAccountEmail;
});

describe('verifyPubSubPushToken', () => {
  it('never accepts when no audience is configured', async () => {
    config.googlePlay.rtdnAudience = '';
    const r = await verifyPubSubPushToken('anything');
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('AUDIENCE_NOT_CONFIGURED');
  });

  // THE CRITICAL PROPERTY: a token that cannot be validated must NEVER come back
  // ok:true. A wrong-segment-count string is rejected by verifyIdToken before
  // any network/cert fetch, so this is deterministic in every environment.
  it('rejects a malformed token even when an audience is set', async () => {
    config.googlePlay.rtdnAudience = 'test-audience';
    const r = await verifyPubSubPushToken('not.a.real.jwt');
    expect(r.ok).toBe(false);
  });
});
