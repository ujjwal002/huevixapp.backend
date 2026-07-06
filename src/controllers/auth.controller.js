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
import { issueOtp, verifyOtp } from '../services/email.service.js';
import { verifyGoogleIdToken } from '../services/googleAuth.service.js';

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
    emailVerified: u.emailVerified,
    hasPassword: Boolean(u.passwordHash),
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

  // Kick off email verification. Best-effort: a mail outage must not block
  // signup — the user can hit /auth/email/verify/request to resend.
  issueOtp(user, 'VERIFY_EMAIL').catch((e) =>
    console.error('[auth] verification email failed:', e.message)
  );

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

  // Google-only account: no password exists. Burn the same bcrypt time and
  // return the same generic error so the response doesn't reveal whether the
  // email exists or which provider it uses. (The app's Google button still
  // works; the user can also SET a password via the reset flow.)
  if (!user.passwordHash) {
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

// ============================================================================
// Google Sign-In
// ============================================================================

// POST /auth/google  { idToken }
// Verifies the Google ID token, then: existing googleId -> log in; existing
// email -> LINK the Google identity to that account; otherwise create a new
// account (no password; email trusted as verified by Google).
export const googleLogin = asyncHandler(async (req, res) => {
  const g = await verifyGoogleIdToken(req.body.idToken);

  let user = await prisma.user.findUnique({ where: { googleId: g.googleId } });

  if (!user) {
    const byEmail = await prisma.user.findUnique({ where: { email: g.email } });
    if (byEmail) {
      // Link ONLY when Google attests it verified this email — otherwise
      // someone who registered an unverified Google account with the victim's
      // address could take over the victim's password account.
      if (!g.emailVerified) {
        throw ApiError.forbidden(
          'This Google account\'s email is unverified; sign in with your password instead.',
          'GOOGLE_EMAIL_UNVERIFIED'
        );
      }
      user = await prisma.user.update({
        where: { id: byEmail.id },
        data: { googleId: g.googleId, emailVerified: true },
      });
    } else {
      user = await prisma.user.create({
        data: {
          email: g.email,
          googleId: g.googleId,
          emailVerified: g.emailVerified,
          passwordHash: null,
          name: g.name,
          nativeLanguage: 'hi',
          targetLanguage: 'en',
          freeSpeakingCreditsRemaining: config.entitlement.freeSpeakingTrial,
        },
      });
    }
  }

  const tokens = await issueTokens(user);
  res.json({ user: publicUser(user), ...tokens });
});

// ============================================================================
// Email verification
// ============================================================================

// POST /auth/email/verify/request  (auth) — (re)send a verification code.
export const requestEmailVerification = asyncHandler(async (req, res) => {
  if (req.user.emailVerified) return res.json({ alreadyVerified: true });
  await issueOtp(req.user, 'VERIFY_EMAIL');
  res.json({ sent: true });
});

// POST /auth/email/verify/confirm  (auth)  { code }
export const confirmEmailVerification = asyncHandler(async (req, res) => {
  if (req.user.emailVerified) return res.json({ verified: true, alreadyVerified: true });
  const r = await verifyOtp(req.user.id, 'VERIFY_EMAIL', req.body.code);
  if (!r.ok) throw ApiError.badRequest('Invalid or expired code', r.reason);
  await prisma.user.update({ where: { id: req.user.id }, data: { emailVerified: true } });
  res.json({ verified: true });
});

// ============================================================================
// Password reset (also lets Google-only accounts SET a first password)
// ============================================================================

// POST /auth/password/forgot  { email } — ALWAYS 200, so the endpoint can't be
// used to probe which emails have accounts.
export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  if (user) {
    await issueOtp(user, 'RESET_PASSWORD').catch((e) =>
      console.error('[auth] reset email failed:', e.message)
    );
  }
  res.json({ sent: true }); // identical response whether or not the account exists
});

// POST /auth/password/reset  { email, code, newPassword }
export const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, newPassword } = req.body;
  const user = await prisma.user.findUnique({ where: { email } });
  // Same generic failure for "no such user" and "bad code": no enumeration.
  if (!user) throw ApiError.badRequest('Invalid or expired code', 'CODE_INVALID');

  const r = await verifyOtp(user.id, 'RESET_PASSWORD', code);
  if (!r.ok) throw ApiError.badRequest('Invalid or expired code', r.reason);

  await prisma.$transaction([
    prisma.user.update({
      where: { id: user.id },
      // Proving control of the email inbox also verifies the email.
      data: { passwordHash: await hashPassword(newPassword), emailVerified: true },
    }),
    // A password reset means the old credentials may be compromised: kill every
    // live session so a token thief is logged out too.
    prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);

  res.json({ success: true, message: 'Password updated. Please sign in again.' });
});