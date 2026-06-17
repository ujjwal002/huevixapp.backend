import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { startOfUtcDay, isSameUtcDay } from '../utils/dates.js';

// Centralizes ALL "can this user use the paid feature?" logic.
// Order of access for SPEAKING:
//   1. Active subscriber  -> allowed up to PAID_DAILY_SPEAKING_LIMIT/day
//   2. Free lifetime trial credits remaining -> allowed (the "taste")
//   3. Rewarded-ad credits remaining -> allowed
//   4. Otherwise -> blocked (prompt to subscribe)

export function isSubscriptionActive(user) {
  const sub = user.subscription;
  return Boolean(
    sub &&
      sub.status === 'ACTIVE' &&
      sub.currentPeriodEnd &&
      new Date(sub.currentPeriodEnd) > new Date()
  );
}

export async function countTodaySpeaking(userId) {
  const since = startOfUtcDay();
  return prisma.speakingAttempt.count({
    where: { userId, createdAt: { gte: since } },
  });
}

// Reset a free user's ad credits at the start of each UTC day. Resets BOTH the
// spendable balance and the daily-granted counter (Fix #8).
export async function ensureDailyAdCredits(user) {
  const today = startOfUtcDay();
  if (!isSameUtcDay(user.adCreditsGrantedDate, today)) {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { adCreditsRemaining: 0, adCreditsGrantedToday: 0, adCreditsGrantedDate: today },
    });
    user.adCreditsRemaining = updated.adCreditsRemaining;
    user.adCreditsGrantedToday = updated.adCreditsGrantedToday;
    user.adCreditsGrantedDate = updated.adCreditsGrantedDate;
  }
  return user;
}

export async function getSpeakingAccess(user) {
  await ensureDailyAdCredits(user);

  if (isSubscriptionActive(user)) {
    const usedToday = await countTodaySpeaking(user.id);
    const limit = config.entitlement.paidDailySpeakingLimit;
    if (usedToday < limit) {
      return { allowed: true, source: 'SUBSCRIPTION', remainingToday: limit - usedToday };
    }
    return {
      allowed: false,
      reason: 'DAILY_LIMIT_REACHED',
      message: `Daily limit of ${limit} speaking attempts reached. Resets tomorrow.`,
    };
  }

  if (user.freeSpeakingCreditsRemaining > 0) {
    return { allowed: true, source: 'TRIAL', remainingTrial: user.freeSpeakingCreditsRemaining };
  }

  if (user.adCreditsRemaining > 0) {
    return { allowed: true, source: 'AD', remainingAdCredits: user.adCreditsRemaining };
  }

  return {
    allowed: false,
    reason: 'PAYWALL',
    message: 'Your free speaking attempts are used up. Subscribe to keep practising speaking.',
  };
}

// Fix #7: atomically RESERVE a consumable credit BEFORE doing the expensive,
// paid assessment. The conditional `updateMany` only decrements when a credit
// is actually available, so two concurrent requests cannot both spend the same
// credit (the second one matches 0 rows). Returns true if a credit was taken.
// SUBSCRIPTION usage is tracked by the SpeakingAttempt row count, so there is
// nothing to reserve.
export async function reserveCredit(user, source) {
  if (source === 'TRIAL') {
    const r = await prisma.user.updateMany({
      where: { id: user.id, freeSpeakingCreditsRemaining: { gt: 0 } },
      data: { freeSpeakingCreditsRemaining: { decrement: 1 } },
    });
    if (r.count === 1) user.freeSpeakingCreditsRemaining -= 1;
    return r.count === 1;
  }
  if (source === 'AD') {
    const r = await prisma.user.updateMany({
      where: { id: user.id, adCreditsRemaining: { gt: 0 } },
      data: { adCreditsRemaining: { decrement: 1 } },
    });
    if (r.count === 1) user.adCreditsRemaining -= 1;
    return r.count === 1;
  }
  return true; // SUBSCRIPTION
}

// Fix #7: give a reserved credit back if the assessment fails, so a failed
// external call never costs the user a credit.
export async function refundCredit(user, source) {
  if (source === 'TRIAL') {
    await prisma.user.update({
      where: { id: user.id },
      data: { freeSpeakingCreditsRemaining: { increment: 1 } },
    });
    user.freeSpeakingCreditsRemaining += 1;
  } else if (source === 'AD') {
    await prisma.user.update({
      where: { id: user.id },
      data: { adCreditsRemaining: { increment: 1 } },
    });
    user.adCreditsRemaining += 1;
  }
}

// Grant a rewarded-ad credit (free users only), capped per day.
// Fix #8: the cap is enforced against adCreditsGrantedToday (credits GRANTED
// today), NOT the spendable balance, so a user can no longer earn unlimited
// credits by spending and re-watching ads. The conditional updateMany also
// makes granting atomic, so concurrent claims cannot exceed the daily cap.
export async function grantAdCredit(user) {
  await ensureDailyAdCredits(user);

  if (isSubscriptionActive(user)) {
    return { granted: false, reason: 'ALREADY_SUBSCRIBED' };
  }

  const max = config.entitlement.maxAdCreditsPerDay;
  const today = startOfUtcDay();
  const r = await prisma.user.updateMany({
    where: { id: user.id, adCreditsGrantedToday: { lt: max } },
    data: {
      adCreditsRemaining: { increment: 1 },
      adCreditsGrantedToday: { increment: 1 },
      adCreditsGrantedDate: today,
    },
  });

  if (r.count === 0) {
    return { granted: false, reason: 'DAILY_AD_LIMIT', adCreditsRemaining: user.adCreditsRemaining };
  }

  const fresh = await prisma.user.findUnique({
    where: { id: user.id },
    select: { adCreditsRemaining: true, adCreditsGrantedToday: true },
  });
  user.adCreditsRemaining = fresh.adCreditsRemaining;
  user.adCreditsGrantedToday = fresh.adCreditsGrantedToday;
  return {
    granted: true,
    adCreditsRemaining: fresh.adCreditsRemaining,
    grantedToday: fresh.adCreditsGrantedToday,
    dailyCap: max,
  };
}

export async function getEntitlementSummary(user) {
  await ensureDailyAdCredits(user);
  const active = isSubscriptionActive(user);
  const usedToday = active ? await countTodaySpeaking(user.id) : 0;
  return {
    subscriptionActive: active,
    plan: user.subscription?.plan || null,
    currentPeriodEnd: user.subscription?.currentPeriodEnd || null,
    freeSpeakingCreditsRemaining: user.freeSpeakingCreditsRemaining,
    adCreditsRemaining: user.adCreditsRemaining,
    adCreditsGrantedToday: user.adCreditsGrantedToday,
    maxAdCreditsPerDay: config.entitlement.maxAdCreditsPerDay,
    paidDailyLimit: config.entitlement.paidDailySpeakingLimit,
    paidUsedToday: usedToday,
  };
}