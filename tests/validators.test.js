import { describe, it, expect } from 'vitest';
import { createPromoSchema, createSponsoredSchema } from '../src/validators/schemas.js';

const basePromo = { startupName: 'Acme', title: 'Hi', body: 'Body', days: 1 };
const baseSponsored = { advertiser: 'Acme', title: 'Hi', body: 'Body' };

describe('promo ctaUrl (httpUrl: strict absolute http/https)', () => {
  it('accepts https and http URLs', () => {
    expect(createPromoSchema.body.safeParse({ ...basePromo, ctaUrl: 'https://acme.com' }).success).toBe(true);
    expect(createPromoSchema.body.safeParse({ ...basePromo, ctaUrl: 'http://acme.com/x' }).success).toBe(true);
  });

  it('rejects javascript:, data:, and root-relative paths', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/checkout', '//evil.com']) {
      expect(createPromoSchema.body.safeParse({ ...basePromo, ctaUrl: bad }).success).toBe(false);
    }
  });
});

describe('sponsored ctaUrl (safeLinkUrl: http(s) OR in-app root-relative)', () => {
  it('accepts http(s) and a single-leading-slash in-app path', () => {
    expect(createSponsoredSchema.body.safeParse({ ...baseSponsored, ctaUrl: 'https://acme.com' }).success).toBe(true);
    expect(createSponsoredSchema.body.safeParse({ ...baseSponsored, ctaUrl: '/checkout?plan=MONTHLY' }).success).toBe(true);
  });

  it('rejects javascript:, data:, and protocol-relative //host', () => {
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//evil.com']) {
      expect(createSponsoredSchema.body.safeParse({ ...baseSponsored, ctaUrl: bad }).success).toBe(false);
    }
  });
});