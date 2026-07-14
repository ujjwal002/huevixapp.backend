import { describe, it, expect, afterEach } from 'vitest';
import { config } from '../src/config/env.js';
import {
  tutorApplySchema,
  resetPasswordSchema,
  googleLoginSchema,
} from '../src/validators/schemas.js';
import { verifyGoogleIdToken } from '../src/services/googleAuth.service.js';

const originalMock = config.mockExternal;
afterEach(() => {
  config.mockExternal = originalMock;
});

describe('tutorApplySchema', () => {
  const base = {
    bio: 'I have taught spoken English for three years to school students.',
    languages: 'en,hi',
    upiId: 'ujjwal@upi',
  };
  it('accepts a valid application', () => {
    expect(tutorApplySchema.body.safeParse(base).success).toBe(true);
  });
  it('rejects a bad UPI id', () => {
    expect(tutorApplySchema.body.safeParse({ ...base, upiId: 'not a upi' }).success).toBe(false);
    expect(tutorApplySchema.body.safeParse({ ...base, upiId: '@bank' }).success).toBe(false);
  });
  it('rejects a too-short bio', () => {
    expect(tutorApplySchema.body.safeParse({ ...base, bio: 'hi' }).success).toBe(false);
  });
});

describe('resetPasswordSchema', () => {
  it('requires a 6-digit code and 8+ char password', () => {
    const ok = resetPasswordSchema.body.safeParse({
      email: 'a@b.com',
      code: '123456',
      newPassword: 'password123',
    });
    expect(ok.success).toBe(true);
    expect(
      resetPasswordSchema.body.safeParse({
        email: 'a@b.com',
        code: '12345',
        newPassword: 'password123',
      }).success
    ).toBe(false);
    expect(
      resetPasswordSchema.body.safeParse({ email: 'a@b.com', code: '123456', newPassword: 'short' })
        .success
    ).toBe(false);
  });
});

describe('verifyGoogleIdToken (mock mode)', () => {
  it('parses a mock JSON token and normalizes the email', async () => {
    config.mockExternal = true;
    const g = await verifyGoogleIdToken(
      JSON.stringify({ sub: 'g-123', email: ' Test@Example.COM ', name: 'T', email_verified: true })
    );
    expect(g.googleId).toBe('g-123');
    expect(g.email).toBe('test@example.com');
    expect(g.emailVerified).toBe(true);
  });
  it('rejects a mock token missing sub/email', async () => {
    config.mockExternal = true;
    await expect(verifyGoogleIdToken(JSON.stringify({ email: 'x@y.com' }))).rejects.toMatchObject({
      code: 'BAD_MOCK_TOKEN',
    });
  });
  it('schema caps token size', () => {
    expect(googleLoginSchema.body.safeParse({ idToken: 'x'.repeat(5000) }).success).toBe(false);
  });
});
