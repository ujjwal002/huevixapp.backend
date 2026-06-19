import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { config } from '../config/env.js';

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwt.accessSecret, {
    expiresIn: config.jwt.accessTtl,
    algorithm: 'HS256',
  });
}

export function verifyAccessToken(token) {
  // Pin the algorithm explicitly. jsonwebtoken v9 already rejects `alg: none`,
  // but pinning closes any algorithm-confusion surface for good.
  return jwt.verify(token, config.jwt.accessSecret, { algorithms: ['HS256'] });
}

// Refresh tokens are opaque random strings; only their hash is stored in the DB.
export function generateRefreshToken() {
  const raw = crypto.randomBytes(48).toString('hex');
  const hash = hashToken(raw);
  const expiresAt = new Date(Date.now() + config.jwt.refreshTtlDays * 24 * 60 * 60 * 1000);
  return { raw, hash, expiresAt };
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
