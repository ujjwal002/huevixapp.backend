// All "day" logic is UTC-date based for simplicity. For a single-region app you
// may prefer to offset to IST (UTC+5:30); centralize that here if so.

export function startOfUtcDay(d = new Date()) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

export function isSameUtcDay(a, b) {
  if (!a || !b) return false;
  return startOfUtcDay(a).getTime() === startOfUtcDay(b).getTime();
}

export function isYesterdayUtc(prev, now = new Date()) {
  if (!prev) return false;
  const oneDay = 24 * 60 * 60 * 1000;
  return startOfUtcDay(now).getTime() - startOfUtcDay(prev).getTime() === oneDay;
}
