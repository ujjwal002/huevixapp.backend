import rateLimit from 'express-rate-limit';
import { config } from '../config/env.js';

export const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  // Never rate-limit the health check: it's a monitoring endpoint (UptimeRobot
  // polls it every few minutes from fixed IPs), and a 429 here would trip false
  // "down" alerts. It's a trivial DB ping, so it's safe to leave uncapped.
  skip: (req) => req.originalUrl === `${config.apiPrefix}/health`,
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

// Creating a promo mints a real payment-gateway order each call. Cap it so a
// single account can't spam draft promos / orphan orders.
export const promoCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: { error: { message: 'Too many promo drafts, try again later', code: 'RATE_LIMITED' } },
  standardHeaders: true,
  legacyHeaders: false,
});
// Endpoints that SEND email (verification / reset OTPs). Tight cap: each hit
// costs an outbound mail and could be used to bombard a victim's inbox.
export const emailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: { message: 'Too many email requests, try again later', code: 'RATE_LIMITED' } },
  standardHeaders: true,
  legacyHeaders: false,
});
