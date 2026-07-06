import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { isOnline as isConnected } from '../realtime/presence.js';
import { earningsSummary } from '../services/tutor.service.js';

// =============================================================================
// Tutor marketplace HTTP surface.
//
// Lifecycle: user applies -> PENDING -> admin approves/rejects -> APPROVED
// tutors toggle isOnline and take paid calls -> earnings accrue per call ->
// admin pays the UPI manually and logs a TutorPayout.
// =============================================================================

function publicTutor(p, user) {
  return {
    userId: p.userId,
    name: user?.name || 'Tutor',
    bio: p.bio,
    languages: p.languages,
    experience: p.experience,
    ratePaisePerHour: p.ratePaisePerHour,
  };
}

// POST /tutors/apply  (auth) — submit an application. One per user; a REJECTED
// user may re-apply (resets to PENDING with the new details).
export const apply = asyncHandler(async (req, res) => {
  // Payouts go to a UPI id tied to this email — require a verified inbox
  // before anyone can enter the money loop.
  if (!req.user.emailVerified) {
    throw ApiError.forbidden('Verify your email before applying as a tutor', 'EMAIL_NOT_VERIFIED');
  }

  const existing = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (existing && existing.status !== 'REJECTED') {
    throw ApiError.conflict(`You already have a ${existing.status.toLowerCase()} application`, 'ALREADY_APPLIED');
  }

  const { bio, languages, experience, upiId } = req.body;
  const data = {
    bio,
    languages,
    experience: experience || null,
    upiId,
    status: 'PENDING',
    rejectionReason: null,
    isOnline: false,
    ratePaisePerHour: config.tutorMarket.ratePaisePerHour,
  };

  const profile = existing
    ? await prisma.tutorProfile.update({ where: { userId: req.user.id }, data })
    : await prisma.tutorProfile.create({ data: { userId: req.user.id, ...data } });

  res.status(201).json({ status: profile.status, ratePaisePerHour: profile.ratePaisePerHour });
});

// GET /tutors/me  (auth) — application status + earnings + payout history.
export const me = asyncHandler(async (req, res) => {
  const profile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) return res.json({ tutor: null });

  const [summary, payouts] = await Promise.all([
    earningsSummary(req.user.id),
    prisma.tutorPayout.findMany({
      where: { tutorUserId: req.user.id },
      orderBy: { createdAt: 'desc' },
      take: 20,
    }),
  ]);

  res.json({
    tutor: {
      status: profile.status,
      rejectionReason: profile.rejectionReason,
      isOnline: profile.isOnline,
      bio: profile.bio,
      languages: profile.languages,
      experience: profile.experience,
      upiId: profile.upiId,
      ratePaisePerHour: profile.ratePaisePerHour,
    },
    earnings: summary,
    payouts,
  });
});

// PATCH /tutors/me  (auth) — edit profile fields / toggle availability.
export const updateMe = asyncHandler(async (req, res) => {
  const profile = await prisma.tutorProfile.findUnique({ where: { userId: req.user.id } });
  if (!profile) throw ApiError.notFound('You are not a tutor');

  const { bio, languages, experience, upiId, isOnline } = req.body;
  const data = {};
  if (bio !== undefined) data.bio = bio;
  if (languages !== undefined) data.languages = languages;
  if (experience !== undefined) data.experience = experience;
  if (upiId !== undefined) data.upiId = upiId;

  if (isOnline !== undefined) {
    // Only APPROVED tutors can appear online; anyone can go offline.
    if (isOnline && profile.status !== 'APPROVED') {
      throw ApiError.forbidden('Your tutor application is not approved yet', 'NOT_APPROVED');
    }
    data.isOnline = isOnline;
  }

  const updated = await prisma.tutorProfile.update({ where: { userId: req.user.id }, data });
  res.json({ isOnline: updated.isOnline, status: updated.status });
});

// GET /tutors/online  (auth) — approved tutors who are BOTH toggled online and
// actually connected to the realtime layer (a stale DB flag alone won't list
// someone whose app was killed). This backs the "pick a tutor" screen.
export const listOnline = asyncHandler(async (req, res) => {
  const rows = await prisma.tutorProfile.findMany({
    where: { status: 'APPROVED', isOnline: true, userId: { not: req.user.id } },
    include: { user: { select: { id: true, name: true } } },
    take: 100,
  });
  const items = rows.filter((p) => isConnected(p.userId)).map((p) => publicTutor(p, p.user));
  res.json({ items, count: items.length });
});

// ---------------------------------------------------------------------------
// Admin
// ---------------------------------------------------------------------------

// GET /tutors/admin?status=PENDING
export const adminList = asyncHandler(async (req, res) => {
  const status = ['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED'].includes(req.query.status)
    ? req.query.status
    : undefined;
  const rows = await prisma.tutorProfile.findMany({
    where: status ? { status } : {},
    orderBy: { createdAt: 'desc' },
    take: 100,
    include: { user: { select: { id: true, email: true, name: true, emailVerified: true } } },
  });

  const items = await Promise.all(
    rows.map(async (p) => ({
      ...p,
      earnings: await earningsSummary(p.userId),
    }))
  );
  res.json({ items });
});

// POST /tutors/admin/:id/approve   (:id = tutor USER id)
export const adminApprove = asyncHandler(async (req, res) => {
  const p = await prisma.tutorProfile.update({
    where: { userId: req.params.id },
    data: { status: 'APPROVED', rejectionReason: null },
  });
  res.json({ userId: p.userId, status: p.status });
});

// POST /tutors/admin/:id/reject  { reason? }
export const adminReject = asyncHandler(async (req, res) => {
  const p = await prisma.tutorProfile.update({
    where: { userId: req.params.id },
    data: { status: 'REJECTED', isOnline: false, rejectionReason: req.body?.reason || null },
  });
  res.json({ userId: p.userId, status: p.status });
});

// POST /tutors/admin/:id/suspend — pull a live tutor (safety / abuse).
export const adminSuspend = asyncHandler(async (req, res) => {
  const p = await prisma.tutorProfile.update({
    where: { userId: req.params.id },
    data: { status: 'SUSPENDED', isOnline: false },
  });
  res.json({ userId: p.userId, status: p.status });
});

// POST /tutors/admin/:id/payouts  { amountPaise, reference? }
// The admin has ALREADY paid the UPI manually; this records it. Guard: cannot
// log a payout larger than what's owed (typo protection, not fraud protection
// — the admin is trusted, their fingers are not).
export const adminRecordPayout = asyncHandler(async (req, res) => {
  const tutorUserId = req.params.id;
  const { amountPaise, reference } = req.body;

  const profile = await prisma.tutorProfile.findUnique({ where: { userId: tutorUserId } });
  if (!profile) throw ApiError.notFound('Tutor not found');

  const summary = await earningsSummary(tutorUserId);
  if (amountPaise > summary.owedPaise) {
    throw ApiError.badRequest(
      `Amount exceeds balance owed (${summary.owedPaise} paise)`,
      'AMOUNT_EXCEEDS_OWED'
    );
  }

  const payout = await prisma.tutorPayout.create({
    data: { tutorUserId, amountPaise, upiId: profile.upiId, reference: reference || null },
  });
  const fresh = await earningsSummary(tutorUserId);
  res.status(201).json({ payout, owedPaise: fresh.owedPaise });
});