import rateLimit from 'express-rate-limit';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
});

// Tighter limit on auth to slow credential stuffing.
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: { message: 'Too many attempts, try again later', code: 'RATE_LIMITED' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// Speaking endpoint hits paid external APIs; cap bursts hard.
export const speakingLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { error: { message: 'Slow down on speaking attempts', code: 'RATE_LIMITED' } },
  standardHeaders: true,
  legacyHeaders: false,
});

// High-frequency, low-value metric pings (promo impressions/clicks). Capped so
// they can't be used to inflate counters or hammer the database.
export const metricsLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  message: { error: { message: 'Too many requests', code: 'RATE_LIMITED' } },
  standardHeaders: true,
  legacyHeaders: false,
});