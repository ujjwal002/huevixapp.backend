import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { verifyPassword } from '../utils/password.js';
import { getEntitlementSummary } from '../services/entitlement.service.js';
import { deleteObject } from '../services/storage.service.js';
import { cancelRecurringSubscription } from '../services/payment.service.js';
import { verifyGoogleIdToken } from '../services/googleAuth.service.js';

export const getMe = asyncHandler(async (req, res) => {
  const u = req.user;
  res.json({
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
  });
});

export const updateMe = asyncHandler(async (req, res) => {
  // Map only user-editable fields. Validation already strips unknown keys, but
  // an explicit allow-list keeps mass-assignment (e.g. role/email) impossible
  // even if the schema is loosened later.
  const { name, nativeLanguage, targetLanguage } = req.body;
  const data = {};
  if (name !== undefined) data.name = name;
  if (nativeLanguage !== undefined) data.nativeLanguage = nativeLanguage;
  if (targetLanguage !== undefined) data.targetLanguage = targetLanguage;

  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data,
  });
  res.json({
    id: updated.id,
    name: updated.name,
    nativeLanguage: updated.nativeLanguage,
    targetLanguage: updated.targetLanguage,
  });
});

export const getStats = asyncHandler(async (req, res) => {
  const entitlement = await getEntitlementSummary(req.user);
  const [cardsCompleted, speakingAttempts] = await Promise.all([
    prisma.cardCompletion.count({ where: { userId: req.user.id } }),
    prisma.speakingAttempt.count({ where: { userId: req.user.id } }),
  ]);
  res.json({
    currentStreak: req.user.currentStreak,
    longestStreak: req.user.longestStreak,
    cardsCompleted,
    speakingAttempts,
    entitlement,
  });
});

export const getLeaderboard = asyncHandler(async (req, res) => {
  const top = await prisma.user.findMany({
    where: { role: { not: 'ADMIN' } }, // <-- hide admin accounts
    orderBy: [{ longestStreak: 'desc' }, { currentStreak: 'desc' }],
    take: 5,
    select: { id: true, name: true, currentStreak: true, longestStreak: true },
  });
  res.json({
    items: top.map((u, i) => ({
      rank: i + 1,
      name: u.name || 'Learner',
      currentStreak: u.currentStreak,
      longestStreak: u.longestStreak,
      isMe: u.id === req.user.id,
    })),
  });
});

// Recordings store the raw storage KEY (e.g. "recordings/<uuid>.webm"), but
// promo/card images store a full public URL. deleteObject() wants the key, so
// turn a stored public URL back into its key. Returns null if it can't.
function urlToStorageKey(value) {
  if (!value) return null;
  // Already a bare key (no scheme): use as-is.
  if (!/^https?:\/\//i.test(value) && !value.startsWith('/')) return value;
  const base = config.storage.publicBaseUrl;
  if (base && value.startsWith(`${base}/`)) return value.slice(base.length + 1);
  // Fallback: grab "<folder>/<file>" for a known storage folder.
  const m = value.match(/(?:^|\/)(images|recordings|tts|misc)\/[^/?#]+/i);
  return m ? m[0].replace(/^\//, '') : null;
}

// DELETE /users/me — permanently delete the account and all associated data.
// Required by Google Play / Apple for any app with account creation. Removes:
//   - the User row, which cascades to refresh tokens, completions, speaking
//     attempts, saved cards, vocab progress, tutor sessions, device tokens,
//     calls, blocks, reports, promos, and the subscription (schema relations
//     are all onDelete: Cascade);
//   - any future Razorpay autopay charges (cancelled first, best-effort);
//   - the user's stored objects (speaking recordings, promo images), which a
//     DB cascade does NOT touch.
export const deleteMe = asyncHandler(async (req, res) => {
  const { password, googleIdToken } = req.body;

  // Re-authenticate. A stolen access token alone must not be able to wipe an
  // account; the user proves ownership with their password — or, for
  // Google-only accounts (no password), a FRESH Google ID token whose
  // googleId matches the account.
  if (req.user.passwordHash) {
    if (!password) throw ApiError.badRequest('Password is required', 'PASSWORD_REQUIRED');
    const ok = await verifyPassword(password, req.user.passwordHash);
    if (!ok) throw ApiError.unauthorized('Password is incorrect', 'BAD_PASSWORD');
  } else {
    if (!googleIdToken) {
      throw ApiError.badRequest(
        'Confirm with Google sign-in to delete this account',
        'GOOGLE_CONFIRM_REQUIRED'
      );
    }
    const g = await verifyGoogleIdToken(googleIdToken);
    if (g.googleId !== req.user.googleId) {
      throw ApiError.unauthorized('Google account does not match', 'GOOGLE_MISMATCH');
    }
  }

  const userId = req.user.id;

  // 1) Collect the user's stored files BEFORE the rows are gone (cascade
  //    removes the rows but never the underlying objects in storage).
  const [attempts, promos] = await Promise.all([
    prisma.speakingAttempt.findMany({ where: { userId }, select: { audioUrl: true } }),
    prisma.startupPromo.findMany({ where: { ownerId: userId }, select: { imageUrl: true } }),
  ]);
  const fileKeys = [
    ...attempts.map((a) => a.audioUrl), // stored as a key
    ...promos.map((p) => urlToStorageKey(p.imageUrl)), // stored as a public URL
  ].filter(Boolean);

  // 2) Stop future autopay charges on Razorpay (best-effort; we still delete
  //    locally even if the provider call fails).
  if (req.user.subscription?.providerRefId) {
    await cancelRecurringSubscription(req.user.subscription.providerRefId).catch(() => {});
  }

  // 3) Delete the user. FK cascades remove every owned row atomically —
  //    including RefreshToken (onDelete: Cascade), so all sessions die here.
  //    Any still-valid access token (stateless, ≤15m) is also dead in practice:
  //    requireAuth re-loads the user on every request and 401s once it's gone.
  //    NOTE: if this is ever changed to a SOFT delete, add an explicit
  //    refreshToken.updateMany({ revokedAt }) here — the cascade is what kills
  //    sessions today.
  await prisma.user.delete({ where: { id: userId } });

  // 4) Best-effort purge of the now-orphaned storage objects.
  await Promise.allSettled(fileKeys.map((key) => deleteObject(key)));

  res.json({ success: true, deleted: true });
});
