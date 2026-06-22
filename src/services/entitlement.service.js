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
    sub && sub.status === 'ACTIVE' && sub.currentPeriodEnd && new Date(sub.currentPeriodEnd) > new Date()
  );
}

// Race-safe "reset this counter once per UTC day" primitive. The conditional
// updateMany resets ONLY when the stored date isn't already today, so two
// concurrent first-of-day requests can't both zero the row (the second matches
// no rows). Returns true if this call performed the reset.
async function resetIfNewDay(userId, { dateField, zeroFields }) {
  const today = startOfUtcDay();
  const data = { [dateField]: today };
  for (const f of zeroFields) data[f] = 0;
  const r = await prisma.user.updateMany({
    where: { id: userId, OR: [{ [dateField]: null }, { [dateField]: { not: today } }] },
    data,
  });
  return r.count > 0;
}

// Reset a free user's ad credits at the start of each UTC day. Resets BOTH the
// spendable balance and the daily-granted counter (Fix #8), concurrency-safely.
export async function ensureDailyAdCredits(user) {
  const today = startOfUtcDay();
  if (!isSameUtcDay(user.adCreditsGrantedDate, today)) {
    await resetIfNewDay(user.id, {
      dateField: 'adCreditsGrantedDate',
      zeroFields: ['adCreditsRemaining', 'adCreditsGrantedToday'],
    });
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { adCreditsRemaining: true, adCreditsGrantedToday: true, adCreditsGrantedDate: true },
    });
    if (fresh) Object.assign(user, fresh);
  }
  return user;
}

// Reset the subscriber daily-speaking counter at the start of each UTC day.
export async function ensureDailyPaidSpeaking(user) {
  const today = startOfUtcDay();
  if (!isSameUtcDay(user.paidSpeakingDate, today)) {
    await resetIfNewDay(user.id, { dateField: 'paidSpeakingDate', zeroFields: ['paidSpeakingCount'] });
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { paidSpeakingCount: true, paidSpeakingDate: true },
    });
    if (fresh) Object.assign(user, fresh);
  }
  return user;
}

export async function getSpeakingAccess(user) {
  await ensureDailyAdCredits(user);

  if (isSubscriptionActive(user)) {
    await ensureDailyPaidSpeaking(user);
    const limit = config.entitlement.paidDailySpeakingLimit;
    if ((user.paidSpeakingCount ?? 0) < limit) {
      return { allowed: true, source: 'SUBSCRIPTION', remainingToday: limit - (user.paidSpeakingCount ?? 0) };
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
//
// For SUBSCRIPTION there is no stored balance, but the per-day cap is enforced
// the same way: we atomically increment paidSpeakingCount only while it is below
// the limit and dated today, so concurrent attempts can no longer overshoot the
// daily cap (previously a count-then-create race).
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
  if (source === 'SUBSCRIPTION') {
    await ensureDailyPaidSpeaking(user);
    const today = startOfUtcDay();
    const limit = config.entitlement.paidDailySpeakingLimit;
    const r = await prisma.user.updateMany({
      where: { id: user.id, paidSpeakingDate: today, paidSpeakingCount: { lt: limit } },
      data: { paidSpeakingCount: { increment: 1 } },
    });
    if (r.count === 1) user.paidSpeakingCount = (user.paidSpeakingCount ?? 0) + 1;
    return r.count === 1;
  }
  return true;
}

// Fix #7: give a reserved credit back if the assessment fails, so a failed
// external call never costs the user a credit (or a slot in their daily cap).
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
  } else if (source === 'SUBSCRIPTION') {
    // Only give the daily slot back if one was actually consumed today.
    const today = startOfUtcDay();
    const r = await prisma.user.updateMany({
      where: { id: user.id, paidSpeakingDate: today, paidSpeakingCount: { gt: 0 } },
      data: { paidSpeakingCount: { decrement: 1 } },
    });
    if (r.count === 1) user.paidSpeakingCount = Math.max(0, (user.paidSpeakingCount ?? 1) - 1);
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
  if (active) await ensureDailyPaidSpeaking(user);
  const usedToday = active ? (user.paidSpeakingCount ?? 0) : 0;
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
// ===========================================================================
// Practice-call credits — prepaid "recharge" balance + a free daily allowance.
// Independent of the speaking subscription. Metered in SECONDS.
// ===========================================================================

// Reset the free daily call allowance at the start of each UTC day (same
// race-safe primitive used for ad credits / paid speaking).
export async function ensureDailyCallSeconds(user) {
  const today = startOfUtcDay();
  if (!isSameUtcDay(user.callSecondsDate, today)) {
    await resetIfNewDay(user.id, {
      dateField: 'callSecondsDate',
      zeroFields: ['callSecondsUsedToday'],
    });
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { callSecondsUsedToday: true, callSecondsDate: true },
    });
    if (fresh) Object.assign(user, fresh);
  }
  return user;
}

function callSummaryFrom(user) {
  const freeDaily = config.calls.freeDailySeconds;
  const usedToday = user.callSecondsUsedToday ?? 0;
  const balance = user.callSecondsBalance ?? 0;
  const freeLeft = Math.max(0, freeDaily - usedToday);
  const totalLeft = freeLeft + balance;
  return {
    freeDailySeconds: freeDaily,
    freeSecondsLeft: freeLeft,
    balanceSeconds: balance,
    totalSecondsLeft: totalLeft,
    minStartSeconds: config.calls.minStartSeconds,
    canStartCall: totalLeft >= config.calls.minStartSeconds,
  };
}

export async function getCallCreditSummary(user) {
  await ensureDailyCallSeconds(user);
  return callSummaryFrom(user);
}

export async function getCallAccess(user) {
  await ensureDailyCallSeconds(user);
  const summary = callSummaryFrom(user);
  if (summary.canStartCall) return { allowed: true, ...summary };
  return {
    allowed: false,
    reason: 'NO_CALL_BALANCE',
    message: 'You are out of call minutes. Recharge to keep practising.',
    ...summary,
  };
}

// Realtime layer only knows the userId, so load the credit fields and check.
export async function getCallAccessById(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      callSecondsBalance: true,
      callSecondsUsedToday: true,
      callSecondsDate: true,
    },
  });
  if (!user) return { allowed: false, reason: 'USER_NOT_FOUND', message: 'User not found' };
  return getCallAccess(user);
}

// After a call ends, spend the FREE daily allowance first, then the prepaid
// balance. Best-effort post-call accounting (not a pre-call reserve), so a
// single call can at most slightly overshoot before the next gate stops them.
export async function consumeCallSeconds(userId, seconds) {
  const secs = Math.max(0, Math.round(seconds || 0));
  if (secs === 0) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      callSecondsBalance: true,
      callSecondsUsedToday: true,
      callSecondsDate: true,
    },
  });
  if (!user) return;
  await ensureDailyCallSeconds(user);

  const freeDaily = config.calls.freeDailySeconds;
  const freeLeft = Math.max(0, freeDaily - (user.callSecondsUsedToday ?? 0));
  const fromFree = Math.min(secs, freeLeft);
  const fromBalance = Math.min(secs - fromFree, user.callSecondsBalance ?? 0);

  const data = {};
  if (fromFree > 0) data.callSecondsUsedToday = { increment: fromFree };
  if (fromBalance > 0) data.callSecondsBalance = { decrement: fromBalance };
  if (Object.keys(data).length) {
    await prisma.user.update({ where: { id: userId }, data });
  }
}

// Recharge: add prepaid call seconds. Returns the new prepaid balance.
export async function addCallSeconds(userId, seconds) {
  const secs = Math.max(0, Math.round(seconds || 0));
  if (secs === 0) {
    const u = await prisma.user.findUnique({
      where: { id: userId },
      select: { callSecondsBalance: true },
    });
    return u?.callSecondsBalance ?? 0;
  }
  const updated = await prisma.user.update({
    where: { id: userId },
    data: { callSecondsBalance: { increment: secs } },
    select: { callSecondsBalance: true },
  });
  return updated.callSecondsBalance;
}