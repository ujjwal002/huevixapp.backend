import { prisma } from '../db/prisma.js';

// =============================================================================
// Tutor marketplace core: profile lookups + the earnings ledger.
//
// Money model (all integers, paise):
//   earned  = sum(TutorEarning.amountPaise)      accrued per finished call
//   paid    = sum(TutorPayout.amountPaise)       admin logs manual UPI payouts
//   owed    = earned - paid
//
// Earnings are an APPEND-ONLY ledger with unique(callId), so a retried
// endRoom / crash-replay can never double-pay a call, and history is auditable.
// =============================================================================

export async function getApprovedTutor(userId) {
  const p = await prisma.tutorProfile.findUnique({ where: { userId } });
  return p && p.status === 'APPROVED' ? p : null;
}

// Accrue a tutor's earnings for a finished call. Idempotent via unique(callId).
export async function accrueEarning({ tutorUserId, callId, seconds }) {
  const secs = Math.max(0, Math.round(seconds || 0));
  if (secs === 0) return null;

  const profile = await prisma.tutorProfile.findUnique({
    where: { userId: tutorUserId },
    select: { ratePaisePerHour: true, status: true },
  });
  // No approved profile -> not a payable tutor call (shouldn't happen; guard).
  if (!profile || profile.status !== 'APPROVED') return null;

  const amountPaise = Math.round((secs * profile.ratePaisePerHour) / 3600);
  if (amountPaise === 0) return null;

  try {
    return await prisma.tutorEarning.create({
      data: { tutorUserId, callId, seconds: secs, amountPaise },
    });
  } catch (e) {
    if (e?.code === 'P2002') return null; // already accrued for this call
    throw e;
  }
}

export async function earningsSummary(tutorUserId) {
  const [earned, paid] = await Promise.all([
    prisma.tutorEarning.aggregate({
      where: { tutorUserId },
      _sum: { amountPaise: true, seconds: true },
      _count: true,
    }),
    prisma.tutorPayout.aggregate({ where: { tutorUserId }, _sum: { amountPaise: true } }),
  ]);
  const earnedPaise = earned._sum.amountPaise ?? 0;
  const paidPaise = paid._sum.amountPaise ?? 0;
  return {
    totalCalls: earned._count,
    totalSeconds: earned._sum.seconds ?? 0,
    earnedPaise,
    paidPaise,
    owedPaise: earnedPaise - paidPaise,
  };
}
