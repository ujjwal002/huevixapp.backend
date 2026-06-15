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
  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: req.body,
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
