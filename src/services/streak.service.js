import { prisma } from '../db/prisma.js';
import { startOfUtcDay, isSameUtcDay, isYesterdayUtc } from '../utils/dates.js';

// Called when a user completes a qualifying activity (finishing a card).
// Increments streak once per day; resets if a day was missed.
export async function touchStreak(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return null;

  const today = startOfUtcDay();
  const last = user.lastActivityDate;

  if (isSameUtcDay(last, today)) {
    return { currentStreak: user.currentStreak, longestStreak: user.longestStreak, changed: false };
  }

  let currentStreak;
  if (isYesterdayUtc(last, today)) {
    currentStreak = user.currentStreak + 1; // continued the streak
  } else {
    currentStreak = 1; // streak broken or first activity
  }
  const longestStreak = Math.max(currentStreak, user.longestStreak);

  await prisma.user.update({
    where: { id: userId },
    data: { currentStreak, longestStreak, lastActivityDate: today },
  });

  return { currentStreak, longestStreak, changed: true };
}
