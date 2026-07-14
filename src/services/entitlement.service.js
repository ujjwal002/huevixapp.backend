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
  if (!sub || !sub.currentPeriodEnd) return false;
  // ACTIVE: paid & renewing. CANCELED: auto-renew is off (user cancelled in the
  // Play Store / legacy Razorpay cancel) but the paid period hasn't ended —
  // they keep access until currentPeriodEnd. Google's own SUBSCRIPTION_STATE_
  // CANCELED means exactly this. EXPIRED/PENDING never grant access.
  if (sub.status !== 'ACTIVE' && sub.status !== 'CANCELED') return false;
  return new Date(sub.currentPeriodEnd) > new Date();
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
    await resetIfNewDay(user.id, {
      dateField: 'paidSpeakingDate',
      zeroFields: ['paidSpeakingCount'],
    });
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
      return {
        allowed: true,
        source: 'SUBSCRIPTION',
        remainingToday: limit - (user.paidSpeakingCount ?? 0),
      };
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
    return {
      granted: false,
      reason: 'DAILY_AD_LIMIT',
      adCreditsRemaining: user.adCreditsRemaining,
    };
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
      zeroFields: ['callSecondsUsedToday', 'adCallGrantsToday', 'adVideoSecondsRemaining'],
    });
    const fresh = await prisma.user.findUnique({
      where: { id: user.id },
      select: { callSecondsUsedToday: true, callSecondsDate: true, adVideoSecondsRemaining: true },
    });
    if (fresh) Object.assign(user, fresh);
  }
  return user;
}

function callSummaryFrom(user) {
  const freeDaily = config.calls.freeDailySeconds; // AUDIO-only free allowance (seconds)
  const usedToday = user.callSecondsUsedToday ?? 0;
  const coins = user.coinBalance ?? 0;
  const adVideo = user.adVideoSecondsRemaining ?? 0; // video seconds earned via ads
  const perSecNormal = config.coins.normalPerSec;
  const perSecTutor = config.coins.tutorPerSec;
  const freeLeft = Math.max(0, freeDaily - usedToday);
  const minStart = config.calls.minStartSeconds;

  // Legacy seconds view derived from coins so OLD app builds keep working:
  // "balanceSeconds" = how many NORMAL-call seconds the coins are worth.
  const balanceSecondsFromCoins = Math.floor(coins / perSecNormal);
  const tutorSecondsFromCoins = Math.floor(coins / perSecTutor);

  // Free time applies to AUDIO only (random). VIDEO (random) is unlocked by
  // watching rewarded ads (adVideo seconds) OR by coins. Tutor is coins-only.
  const audioLeft = freeLeft + balanceSecondsFromCoins;
  const videoLeft = adVideo + balanceSecondsFromCoins;

  return {
    // --- coin economy (new apps read these) ---
    coinBalance: coins,
    coinsPerSecNormal: perSecNormal,
    coinsPerSecTutor: perSecTutor,
    tutorSecondsLeft: tutorSecondsFromCoins,
    canStartTutor: coins >= perSecTutor * minStart,
    // --- ad-granted video ---
    adVideoSecondsLeft: adVideo,
    // --- legacy seconds view (old apps keep working) ---
    freeDailySeconds: freeDaily,
    freeSecondsLeft: freeLeft, // audio-only free time left today
    balanceSeconds: balanceSecondsFromCoins,
    audioSecondsLeft: audioLeft,
    videoSecondsLeft: videoLeft,
    totalSecondsLeft: audioLeft,
    minStartSeconds: minStart,
    canStartAudio: audioLeft >= minStart,
    canStartVideo: videoLeft >= minStart,
    canStartCall: audioLeft >= minStart,
  };
}

export async function getCallCreditSummary(user) {
  await ensureDailyCallSeconds(user);
  return callSummaryFrom(user);
}

export async function getCallAccess(user, type = 'AUDIO') {
  await ensureDailyCallSeconds(user);
  const summary = callSummaryFrom(user);
  const ok = type === 'VIDEO' ? summary.canStartVideo : summary.canStartAudio;
  if (ok) return { allowed: true, type, ...summary };
  return {
    allowed: false,
    type,
    reason: type === 'VIDEO' ? 'NO_VIDEO_BALANCE' : 'NO_CALL_BALANCE',
    message:
      type === 'VIDEO'
        ? 'Watch a short ad to get 2 minutes of video, or use coins.'
        : 'You are out of free minutes. Recharge to keep practising.',
    ...summary,
  };
}

// Realtime layer only knows the userId, so load the credit fields and check.
export async function getCallAccessById(userId, type = 'AUDIO') {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      coinBalance: true,
      callSecondsUsedToday: true,
      callSecondsDate: true,
      adVideoSecondsRemaining: true,
    },
  });
  if (!user) return { allowed: false, reason: 'USER_NOT_FOUND', message: 'User not found' };
  return getCallAccess(user, type);
}

// After a call ends, spend the FREE daily allowance first (AUDIO only), then the
// prepaid balance. VIDEO calls skip the free bucket entirely and are billed from
// the prepaid balance. Best-effort post-call accounting (not a pre-call reserve),
// so a single call can at most slightly overshoot before the next gate stops them.
export async function consumeCallSeconds(userId, seconds, type = 'AUDIO') {
  const secs = Math.max(0, Math.round(seconds || 0));
  if (secs === 0) return;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      coinBalance: true,
      callSecondsUsedToday: true,
      callSecondsDate: true,
      adVideoSecondsRemaining: true,
    },
  });
  if (!user) return;
  await ensureDailyCallSeconds(user);

  if (type === 'VIDEO') {
    // Random VIDEO: spend ad-granted seconds first, then coins for the rest.
    // (Audio's free daily allowance never applies to video.)
    const adLeft = Math.max(0, user.adVideoSecondsRemaining ?? 0);
    const fromAd = Math.min(secs, adLeft);
    const paidSecs = secs - fromAd;
    if (fromAd > 0) {
      await prisma.user.update({
        where: { id: userId },
        data: { adVideoSecondsRemaining: { decrement: fromAd } },
      });
    }
    if (paidSecs > 0) {
      await spendCoins(userId, paidSecs * config.coins.normalPerSec);
    }
    return;
  }

  const freeDaily = config.calls.freeDailySeconds;
  // Free daily seconds are AUDIO-only.
  const freeLeft = Math.max(0, freeDaily - (user.callSecondsUsedToday ?? 0));
  const fromFree = Math.min(secs, freeLeft);
  const paidSecs = secs - fromFree;

  if (fromFree > 0) {
    await prisma.user.update({
      where: { id: userId },
      data: { callSecondsUsedToday: { increment: fromFree } },
    });
  }
  if (paidSecs > 0) {
    await spendCoins(userId, paidSecs * config.coins.normalPerSec);
  }
}

// Spend coins, floored at zero, as a pair of CONDITIONAL updates so a
// concurrent spend can't interleave between a read and a write. Post-call
// best-effort accounting: a call can overshoot slightly; the floor absorbs it.
async function spendCoins(userId, coins) {
  const amount = Math.max(0, Math.round(coins || 0));
  if (amount === 0) return;
  const r = await prisma.user.updateMany({
    where: { id: userId, coinBalance: { gte: amount } },
    data: { coinBalance: { decrement: amount } },
  });
  if (r.count === 0) {
    await prisma.user.updateMany({
      where: { id: userId, coinBalance: { gt: 0 } },
      data: { coinBalance: 0 },
    });
  }
}

// Grant purchased coins. Returns the new coin balance.
export async function addCoins(userId, coins) {
  const amount = Math.max(0, Math.round(coins || 0));
  const updated = await prisma.user.update({
    where: { id: userId },
    data: amount > 0 ? { coinBalance: { increment: amount } } : {},
    select: { coinBalance: true },
  });
  return updated.coinBalance;
}

// LEGACY wrapper (dev-mock recharge speaks in seconds): grants the coin
// equivalent of N normal-call seconds. Returns the seconds-view balance so old
// callers keep getting a sane number.
export async function addCallSeconds(userId, seconds) {
  const secs = Math.max(0, Math.round(seconds || 0));
  const coins = await addCoins(userId, secs * config.coins.normalPerSec);
  return Math.floor(coins / config.coins.normalPerSec);
}
// ===========================================================================
// TUTOR calls — paid from the prepaid balance ONLY (no free daily minutes:
// every tutor second costs the platform real money, so it must be revenue-
// backed). Both AUDIO and VIDEO tutor calls follow the same rule.
// ===========================================================================

export async function getTutorCallAccessById(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, coinBalance: true },
  });
  if (!user) return { allowed: false, reason: 'USER_NOT_FOUND', message: 'User not found' };

  const coins = user.coinBalance ?? 0;
  const perSec = config.coins.tutorPerSec;
  const minCoins = perSec * config.calls.minStartSeconds; // e.g. 12 * 20 = 240
  if (coins >= minCoins) {
    return {
      allowed: true,
      coinBalance: coins,
      tutorSecondsLeft: Math.floor(coins / perSec),
      balanceSeconds: Math.floor(coins / config.coins.normalPerSec), // legacy view
    };
  }
  return {
    allowed: false,
    reason: 'NO_TUTOR_BALANCE',
    message: 'Tutor calls use coins. Get coins to talk to a tutor.',
    coinBalance: coins,
    balanceSeconds: Math.floor(coins / config.coins.normalPerSec),
  };
}

// Rewarded-ad grant: N seconds of random VIDEO time, stored in the dedicated
// adVideoSecondsRemaining bucket. Expires at the UTC midnight reset; can never
// be spent on tutor calls or converted to coins, and does NOT affect the free
// audio allowance. Daily-capped; the conditional update makes the cap race-safe.
export async function grantAdCallSeconds(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      callSecondsUsedToday: true,
      callSecondsDate: true,
      adCallGrantsToday: true,
    },
  });
  if (!user) return { granted: false, reason: 'USER_NOT_FOUND' };
  await ensureDailyCallSeconds(user);

  const max = config.entitlement.maxAdCallGrantsPerDay;
  const secs = config.entitlement.adRewardCallSeconds;
  // Watching a rewarded ad grants VIDEO seconds (random video calls), up to
  // maxAdCallGrantsPerDay ads/day. Audio is already free daily; tutor is coins.
  const r = await prisma.user.updateMany({
    where: { id: userId, adCallGrantsToday: { lt: max } },
    data: {
      adVideoSecondsRemaining: { increment: secs },
      adCallGrantsToday: { increment: 1 },
    },
  });
  if (r.count === 0) return { granted: false, reason: 'DAILY_AD_LIMIT' };
  return { granted: true, seconds: secs, appliesTo: 'VIDEO' };
}

// Live-billing watchdog support: how many MORE seconds can this user afford
// for a call of this kind/type, given balances as of call start? (Balances
// only change at call end, so this is stable for the duration of one call.)
export async function remainingCallSeconds(userId, { kind = 'RANDOM', type = 'AUDIO' } = {}) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      coinBalance: true,
      callSecondsUsedToday: true,
      callSecondsDate: true,
      adVideoSecondsRemaining: true,
    },
  });
  if (!user) return 0;

  const coins = user.coinBalance ?? 0;
  if (kind === 'TUTOR') {
    return Math.floor(coins / config.coins.tutorPerSec);
  }
  await ensureDailyCallSeconds(user);
  const coinSeconds = Math.floor(coins / config.coins.normalPerSec);
  if (type === 'VIDEO') {
    // Random video: ad-granted seconds + coin-equivalent seconds (no free audio).
    return Math.max(0, user.adVideoSecondsRemaining ?? 0) + coinSeconds;
  }
  const freeLeft = Math.max(0, config.calls.freeDailySeconds - (user.callSecondsUsedToday ?? 0));
  return freeLeft + coinSeconds;
}

// Tutor-call billing: every second costs coins.tutorPerSec (3x normal).
// Same name as the pre-coin function so rooms.js needs no change.
export async function consumeBalanceSeconds(userId, seconds) {
  const secs = Math.max(0, Math.round(seconds || 0));
  if (secs === 0) return;
  await spendCoins(userId, secs * config.coins.tutorPerSec);
}
