import { describe, it, expect } from 'vitest';
import { timingSafeEqualStr } from '../src/utils/crypto.js';

describe('timingSafeEqualStr — constant-time string compare', () => {
  it('returns true for equal strings', () => {
    expect(timingSafeEqualStr('abc123def456', 'abc123def456')).toBe(true);
  });

  it('returns false for equal-length but different strings', () => {
    expect(timingSafeEqualStr('abc123def456', 'abc123def457')).toBe(false);
  });

  it('returns false on length mismatch without throwing', () => {
    expect(timingSafeEqualStr('short', 'a-much-longer-value')).toBe(false);
  });

  it('handles null/undefined candidate without throwing', () => {
    expect(timingSafeEqualStr('abc', null)).toBe(false);
    expect(timingSafeEqualStr('abc', undefined)).toBe(false);
  });

  it('treats two empty strings as equal', () => {
    expect(timingSafeEqualStr('', '')).toBe(true);
  });
});