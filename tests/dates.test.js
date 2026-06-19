import { describe, it, expect } from 'vitest';
import { startOfUtcDay, isSameUtcDay, isYesterdayUtc } from '../src/utils/dates.js';

describe('dates', () => {
  it('startOfUtcDay zeroes the time component (UTC)', () => {
    const d = new Date('2026-06-20T15:42:09.123Z');
    const s = startOfUtcDay(d);
    expect(s.toISOString()).toBe('2026-06-20T00:00:00.000Z');
  });

  it('isSameUtcDay is true within the same UTC day, false across days', () => {
    const a = new Date('2026-06-20T01:00:00Z');
    const b = new Date('2026-06-20T23:00:00Z');
    const c = new Date('2026-06-21T00:00:00Z');
    expect(isSameUtcDay(a, b)).toBe(true);
    expect(isSameUtcDay(a, c)).toBe(false);
  });

  it('isSameUtcDay returns false when either date is missing', () => {
    expect(isSameUtcDay(null, new Date())).toBe(false);
    expect(isSameUtcDay(new Date(), undefined)).toBe(false);
  });

  it('isYesterdayUtc detects exactly one calendar day earlier', () => {
    const now = new Date('2026-06-20T08:00:00Z');
    expect(isYesterdayUtc(new Date('2026-06-19T23:59:00Z'), now)).toBe(true);
    expect(isYesterdayUtc(new Date('2026-06-20T00:01:00Z'), now)).toBe(false); // same day
    expect(isYesterdayUtc(new Date('2026-06-18T12:00:00Z'), now)).toBe(false); // two days
    expect(isYesterdayUtc(null, now)).toBe(false);
  });
});