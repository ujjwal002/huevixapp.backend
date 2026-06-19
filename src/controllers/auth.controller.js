import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { hashPassword, verifyPassword, DUMMY_PASSWORD_HASH } from '../utils/password.js';
import {
  signAccessToken,
  generateRefreshToken,
  hashToken,
} from '../utils/jwt.js';

function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    nativeLanguage: u.nativeLanguage,
    targetLanguage: u.targetLanguage,
    currentStreak: u.currentStreak,
    longestStreak: u.longestStreak,
  };
}

async function issueTokens(user) {
  const accessToken = signAccessToken(user);
  const { raw, hash, expiresAt } = generateRefreshToken();
  await prisma.refreshToken.create({
    data: { userId: user.id, tokenHash: hash, expiresAt },
  });
  return { accessToken, refreshToken: raw };
}

// Best-effort housekeeping: drop this user's expired/revoked tokens so the
// table doesn't grow without bound (Fix #5).
async function pruneDeadTokens(userId) {
  await prisma.refreshToken
    .deleteMany({
      where: {
        userId,
        OR: [{ expiresAt: { lt: new Date() } }, { revokedAt: { not: null } }],
      },
    })
    .catch(() => {});
}

export const register = asyncHandler(async (req, res) => {
  const { email, password, name, nativeLanguage, targetLanguage } = req.body;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) throw ApiError.conflict('Email already registered', 'EMAIL_TAKEN');

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash: await hashPassword(password),
      name,
      nativeLanguage: nativeLanguage || 'hi',
      targetLanguage: targetLanguage || 'en',
      freeSpeakingCreditsRemaining: config.entitlement.freeSpeakingTrial,
    },
  });

  const tokens = await issueTokens(user);
  res.status(201).json({ user: publicUser(user), ...tokens });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) {
    // Do the same bcrypt work as a real verify so response time doesn't reveal
    // whether the account exists, then fail with the same generic error.
    await verifyPassword(password, DUMMY_PASSWORD_HASH);
    throw ApiError.unauthorized('Invalid credentials', 'BAD_CREDENTIALS');
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw ApiError.unauthorized('Invalid credentials', 'BAD_CREDENTIALS');

  const tokens = await issueTokens(user);
  res.json({ user: publicUser(user), ...tokens });
});

export const refresh = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body;
  const tokenHash = hashToken(refreshToken);

  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  // Unknown or expired token: cannot identify a family, just reject.
  if (!stored || stored.expiresAt < new Date()) {
    throw ApiError.unauthorized('Invalid or expired refresh token', 'REFRESH_INVALID');
  }

  // Fix #5: reuse detection. A token that was already rotated (revoked) being
  // presented again means it was likely stolen/replayed. Revoke the user's
  // entire token family so neither party can keep using leaked tokens.
  if (stored.revokedAt) {
    await prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw ApiError.unauthorized('Refresh token reuse detected; please sign in again', 'REFRESH_REUSE');
  }

  // Rotate: revoke the used token, issue a new pair.
  await prisma.refreshToken.update({
    where: { id: stored.id },
    data: { revokedAt: new Date() },
  });
  const tokens = await issueTokens(stored.user);
  await pruneDeadTokens(stored.userId);
  res.json(tokens);
});

export const logout = asyncHandler(async (req, res) => {
  const { refreshToken } = req.body || {};
  if (refreshToken) {
    await prisma.refreshToken
      .updateMany({
        where: { tokenHash: hashToken(refreshToken), revokedAt: null },
        data: { revokedAt: new Date() },
      })
      .catch(() => {});
  }
  res.json({ success: true });
});