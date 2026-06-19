import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getEntitlementSummary } from '../services/entitlement.service.js';

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
    where: { role: { not: 'ADMIN' } },        // <-- hide admin accounts
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