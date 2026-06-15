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

// Reset a free user's ad credits at the start of each UTC day.
export async function ensureDailyAdCredits(user) {
  const today = startOfUtcDay();
  if (!isSameUtcDay(user.adCreditsGrantedDate, today)) {
    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { adCreditsRemaining: 0, adCreditsGrantedDate: today },
    });
    user.adCreditsRemaining = updated.adCreditsRemaining;
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

// Decrement the relevant counter AFTER a successful assessment.
export async function consumeSpeaking(user, source) {
  if (source === 'TRIAL') {
    await prisma.user.update({
      where: { id: user.id },
      data: { freeSpeakingCreditsRemaining: { decrement: 1 } },
    });
  } else if (source === 'AD') {
    await prisma.user.update({
      where: { id: user.id },
      data: { adCreditsRemaining: { decrement: 1 } },
    });
  }
  // SUBSCRIPTION usage is tracked by the SpeakingAttempt row count (daily cap).
}

// Grant a rewarded-ad credit (free users only), capped per day.
export async function grantAdCredit(user) {
  await ensureDailyAdCredits(user);

  if (isSubscriptionActive(user)) {
    return { granted: false, reason: 'ALREADY_SUBSCRIBED' };
  }
  // Count how many ad credits already granted today by inspecting cap.
  if (user.adCreditsRemaining >= config.entitlement.maxAdCreditsPerDay) {
    return { granted: false, reason: 'DAILY_AD_LIMIT', adCreditsRemaining: user.adCreditsRemaining };
  }
  const updated = await prisma.user.update({
    where: { id: user.id },
    data: { adCreditsRemaining: { increment: 1 }, adCreditsGrantedDate: startOfUtcDay() },
  });
  return { granted: true, adCreditsRemaining: updated.adCreditsRemaining };
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
    paidDailyLimit: config.entitlement.paidDailySpeakingLimit,
    paidUsedToday: usedToday,
  };
}
