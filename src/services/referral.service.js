import { randomBytes } from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';

const REWARD_PAISE = config.referral.rewardPaise; // ₹100 = 10000
const QUALIFYING_DAYS = config.referral.qualifyingDays; // 30
const MIN_QUALIFIED = config.referral.minQualifiedForPayout; // 100

// Short, unambiguous share code (no 0/O/1/I). Collisions are astronomically
// unlikely at this length; we retry a few times just in case.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode(len = 7) {
  const bytes = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

// Ensure the user has a referral code, creating one on first use.
export async function getOrCreateMyCode(userId) {
  const u = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });
  if (u?.referralCode) return u.referralCode;

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { referralCode: randomCode() },
        select: { referralCode: true },
      });
      return updated.referralCode;
    } catch (e) {
      if (e?.code === 'P2002') continue; // code collided — try another
      throw e;
    }
  }
  throw new Error('Could not allocate a referral code');
}

// Attach a new signup to their referrer. Called at register — BEST-EFFORT: any
// problem here (unknown code, self-referral, already-referred) must never block
// the signup, so the caller ignores failures.
export async function attachReferral(referredUserId, rawCode) {
  const code = String(rawCode || '').trim().toUpperCase();
  if (!code) return null;

  const referrer = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true },
  });
  if (!referrer) return null; // unknown code
  if (referrer.id === referredUserId) return null; // no self-referral

  try {
    return await prisma.referral.create({
      data: { referrerId: referrer.id, referredUserId, status: 'PENDING' },
    });
  } catch (e) {
    if (e?.code === 'P2002') return null; // this user was already referred once
    throw e;
  }
}

// Called after a referred user COMPLETES a daily quiz. Recounts their distinct
// completed quiz days and, once they reach the threshold, qualifies the referral
// and snapshots the reward. Idempotent + best-effort (never breaks quiz play).
//
// NOTE: because a user can only answer TODAY's quiz, reaching QUALIFYING_DAYS
// completed days necessarily takes that many real calendar days — which is the
// main organic defence against farmed accounts.
export async function onQuizDayCompleted(userId) {
  const referral = await prisma.referral.findUnique({
    where: { referredUserId: userId },
    select: { id: true, status: true },
  });
  if (!referral || referral.status !== 'PENDING') return;

  // One QuizDailyPlay row per (user, day); completedAt set = that day finished.
  // So the count of completed plays == number of distinct qualifying days.
  const days = await prisma.quizDailyPlay.count({
    where: { userId, completedAt: { not: null } },
  });

  if (days >= QUALIFYING_DAYS) {
    // Conditional updateMany on status guards against a double-qualify race.
    await prisma.referral.updateMany({
      where: { id: referral.id, status: 'PENDING' },
      data: {
        status: 'QUALIFIED',
        qualifiedAt: new Date(),
        qualifyingDays: days,
        rewardPaise: REWARD_PAISE,
      },
    });
  } else {
    // Keep the visible progress fresh for the referrer's dashboard.
    await prisma.referral.update({ where: { id: referral.id }, data: { qualifyingDays: days } });
  }
}

// Earnings math, mirroring the tutor ledger: earned = sum of QUALIFIED rewards;
// settled = payout requests that are PENDING or PAID (a REJECTED request frees
// the balance again). available = earned - settled.
async function balance(userId) {
  const [qualifiedCount, earnedAgg, settledAgg] = await Promise.all([
    prisma.referral.count({ where: { referrerId: userId, status: 'QUALIFIED' } }),
    prisma.referral.aggregate({
      where: { referrerId: userId, status: 'QUALIFIED' },
      _sum: { rewardPaise: true },
    }),
    prisma.referralPayout.aggregate({
      where: { userId, status: { in: ['PENDING', 'PAID'] } },
      _sum: { amountPaise: true },
    }),
  ]);
  const earnedPaise = earnedAgg._sum.rewardPaise ?? 0;
  const settledPaise = settledAgg._sum.amountPaise ?? 0;
  return {
    qualifiedCount,
    earnedPaise,
    settledPaise,
    availablePaise: Math.max(0, earnedPaise - settledPaise),
  };
}

export async function referralSummary(userId) {
  const code = await getOrCreateMyCode(userId);
  const [totals, bal] = await Promise.all([
    prisma.referral.groupBy({ by: ['status'], where: { referrerId: userId }, _count: true }),
    balance(userId),
  ]);
  const byStatus = Object.fromEntries(totals.map((t) => [t.status, t._count]));

  return {
    code,
    shareUrl: `${config.referral.shareBaseUrl}?ref=${code}`,
    rewardInr: Math.round(REWARD_PAISE / 100),
    qualifyingDays: QUALIFYING_DAYS,
    minQualifiedForPayout: MIN_QUALIFIED,
    counts: {
      total: totals.reduce((s, t) => s + t._count, 0),
      pending: byStatus.PENDING || 0,
      qualified: bal.qualifiedCount,
    },
    earnedInr: Math.round(bal.earnedPaise / 100),
    availableInr: Math.round(bal.availablePaise / 100),
    eligibleForPayout: bal.qualifiedCount >= MIN_QUALIFIED && bal.availablePaise > 0,
    remainingToUnlock: Math.max(0, MIN_QUALIFIED - bal.qualifiedCount),
  };
}

export async function requestPayout(userId, upiId) {
  const bal = await balance(userId);
  if (bal.qualifiedCount < MIN_QUALIFIED) {
    return { error: 'NOT_ENOUGH_REFERRALS', need: MIN_QUALIFIED - bal.qualifiedCount };
  }
  if (bal.availablePaise <= 0) return { error: 'NOTHING_AVAILABLE' };

  const payout = await prisma.referralPayout.create({
    data: {
      userId,
      amountPaise: bal.availablePaise,
      count: Math.round(bal.availablePaise / REWARD_PAISE),
      upiId,
      status: 'PENDING',
    },
  });
  return { payout };
}

export async function listMyPayouts(userId) {
  return prisma.referralPayout.findMany({ where: { userId }, orderBy: { createdAt: 'desc' } });
}

// --- Admin -----------------------------------------------------------------
export async function listPayoutRequests() {
  return prisma.referralPayout.findMany({
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: { user: { select: { email: true, name: true } } },
  });
}

// Both admin actions only move a PENDING request, so a paid payout can't be
// re-paid or flipped to rejected. Returns false if it wasn't pending.
export async function markPayoutPaid(id, reference) {
  const r = await prisma.referralPayout.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'PAID', reference: reference || null },
  });
  return r.count === 1;
}

export async function rejectPayout(id, note) {
  const r = await prisma.referralPayout.updateMany({
    where: { id, status: 'PENDING' },
    data: { status: 'REJECTED', note: note || null },
  });
  return r.count === 1;
}