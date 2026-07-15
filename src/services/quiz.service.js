import { prisma } from '../db/prisma.js';
import { generateQuizQuestions, QUIZ_QUESTION_COUNT } from './quizAi.service.js';
import { isSubscriptionActive } from './entitlement.service.js';
import { startOfUtcDay } from '../utils/dates.js';

// =============================================================================
// Quiz scoring + monthly leaderboard + single monthly winner.
//
// All point changes use the same safe pattern as your credit system: atomic
// upserts/increments inside a transaction, with the per-question unique
// constraint preventing double-spend (point farming).
//
// Tweak the numbers here (or move them to env later).
// =============================================================================
const TOTAL_QUESTIONS = QUIZ_QUESTION_COUNT; // 10
const POINTS_PER_CORRECT = 10; // max 100/day from answers
const COMPLETION_BONUS_BASE = 20; // for finishing all 10 in a day
const STREAK_BONUS_PER_DAY = 5; // extra per streak day...
const STREAK_BONUS_CAP_DAYS = 7; // ...capped so a long streak can't snowball
const FAST_COMPLETE_FLAG_SECONDS = 20; // perfect score finished faster than this => flag for review

// Ads: show one interstitial every N questions for non-premium users. The APP
// shows the actual ad (AdMob); the backend only tells it the cadence + whether
// this user is ad-free. 5 keeps it to ~3-4 ads per 20-question session; lower
// values (e.g. 2 = ~10 ads) hurt retention badly, so 5 is a sane default.
const AD_EVERY_N_QUESTIONS = 5;

// --- date helpers (UTC) ------------------------------------------------------
export function periodOf(date = new Date()) {
  const d = new Date(date);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// --- generation / serving ----------------------------------------------------

// Get or lazily create today's quiz for a language. The AI call happens OUTSIDE
// any transaction; the unique([date,targetLanguage]) constraint makes two
// concurrent first-requests safe (one creates, the other reads).
export async function getOrCreateTodayQuiz(targetLanguage = 'en') {
  const date = startOfUtcDay();
  const existing = await prisma.dailyQuiz.findUnique({
    where: { date_targetLanguage: { date, targetLanguage } },
    include: { questions: { orderBy: { order: 'asc' } } },
  });
  if (existing) return existing;

  const generated = await generateQuizQuestions({ targetLanguage });
  try {
    return await prisma.dailyQuiz.create({
      data: {
        date,
        targetLanguage,
        status: 'READY',
        questions: {
          create: generated.slice(0, TOTAL_QUESTIONS).map((q, i) => ({
            order: i,
            prompt: q.prompt,
            options: q.options,
            correctIndex: q.correctIndex,
            explanation: q.explanation || null,
          })),
        },
      },
      include: { questions: { orderBy: { order: 'asc' } } },
    });
  } catch (e) {
    if (e?.code === 'P2002') {
      return prisma.dailyQuiz.findUnique({
        where: { date_targetLanguage: { date, targetLanguage } },
        include: { questions: { orderBy: { order: 'asc' } } },
      });
    }
    throw e;
  }
}

// Serve today's quiz WITHOUT correct answers; mark which the user has answered.
export async function getTodayForUser(user) {
  const targetLanguage = user.targetLanguage || 'en';
  const quiz = await getOrCreateTodayQuiz(targetLanguage);
  if (!quiz) return null;

  // Record the play (startedAt = anti-cheat timing baseline) on first open.
  await prisma.quizDailyPlay.upsert({
    where: { userId_quizId: { userId: user.id, quizId: quiz.id } },
    create: { userId: user.id, quizId: quiz.id },
    update: {},
  });

  const liveQuestions = quiz.questions.filter((q) => !q.voided);
  const answers = await prisma.quizAnswer.findMany({
    where: { userId: user.id, questionId: { in: liveQuestions.map((q) => q.id) } },
    select: { questionId: true, chosenIndex: true, isCorrect: true },
  });
  const byId = new Map(answers.map((a) => [a.questionId, a]));

  // Ad-free if the user has an active subscription (reuses your existing
  // subscription system — no new payment code needed for the ₹250 ad-free tier).
  const premium = isSubscriptionActive(user);

  return {
    quizId: quiz.id,
    date: quiz.date,
    targetLanguage: quiz.targetLanguage,
    totalQuestions: liveQuestions.length,
    ads: { enabled: !premium, everyNQuestions: AD_EVERY_N_QUESTIONS },
    questions: liveQuestions.map((q) => {
      const a = byId.get(q.id);
      return {
        id: q.id,
        order: q.order,
        prompt: q.prompt,
        options: q.options, // NEVER includes correctIndex before answering
        answered: !!a,
        yourChoice: a ? a.chosenIndex : null,
        wasCorrect: a ? a.isCorrect : null,
      };
    }),
  };
}

// --- answering / scoring -----------------------------------------------------

async function bumpQuizStreak(tx, userId, today) {
  const u = await tx.user.findUnique({
    where: { id: userId },
    select: { quizCurrentStreak: true, quizLongestStreak: true, quizLastPlayedDate: true },
  });
  const last = u?.quizLastPlayedDate ? startOfUtcDay(u.quizLastPlayedDate) : null;
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  let streak;
  if (last && last.getTime() === today.getTime()) streak = u.quizCurrentStreak || 1;
  else if (last && last.getTime() === yesterday.getTime()) streak = (u.quizCurrentStreak || 0) + 1;
  else streak = 1;

  const longest = Math.max(u?.quizLongestStreak || 0, streak);
  await tx.user.update({
    where: { id: userId },
    data: { quizCurrentStreak: streak, quizLongestStreak: longest, quizLastPlayedDate: today },
  });
  return streak;
}

export async function submitAnswer(user, { questionId, chosenIndex }) {
  const question = await prisma.quizQuestion.findUnique({
    where: { id: questionId },
    include: { quiz: true },
  });
  if (!question) return { error: 'NOT_FOUND' };
  if (question.voided) return { error: 'VOIDED' };

  // Points are only for TODAY's quiz.
  const today = startOfUtcDay();
  if (startOfUtcDay(question.quiz.date).getTime() !== today.getTime())
    return { error: 'NOT_TODAY' };

  const optionCount = Array.isArray(question.options) ? question.options.length : 0;
  if (!Number.isInteger(chosenIndex) || chosenIndex < 0 || chosenIndex >= optionCount) {
    return { error: 'BAD_CHOICE' };
  }

  const isCorrect = chosenIndex === question.correctIndex;
  const points = isCorrect ? POINTS_PER_CORRECT : 0;
  const period = periodOf(today);

  let outcome;
  try {
    outcome = await prisma.$transaction(async (tx) => {
      // 1) Record the answer — unique(userId, questionId) makes it one-shot.
      await tx.quizAnswer.create({
        data: { userId: user.id, questionId, chosenIndex, isCorrect, pointsAwarded: points },
      });

      // 2) Update daily play counters.
      const play = await tx.quizDailyPlay.upsert({
        where: { userId_quizId: { userId: user.id, quizId: question.quizId } },
        create: {
          userId: user.id,
          quizId: question.quizId,
          answeredCount: 1,
          correctCount: isCorrect ? 1 : 0,
          pointsEarned: points,
        },
        update: {
          answeredCount: { increment: 1 },
          correctCount: { increment: isCorrect ? 1 : 0 },
          pointsEarned: { increment: points },
        },
      });

      // 3) On the final answer, award the completion + streak bonus EXACTLY once
      //    (the conditional updateMany on completedAt:null guards against races).
      let completionBonus = 0;
      let completedNow = false;
      let flagged = false;
      if (play.answeredCount >= TOTAL_QUESTIONS) {
        const claim = await tx.quizDailyPlay.updateMany({
          where: { id: play.id, completedAt: null },
          data: { completedAt: new Date() },
        });
        if (claim.count === 1) {
          completedNow = true;
          const streak = await bumpQuizStreak(tx, user.id, today);
          const streakBonus = Math.min(streak, STREAK_BONUS_CAP_DAYS) * STREAK_BONUS_PER_DAY;
          completionBonus = COMPLETION_BONUS_BASE + streakBonus;

          // Anti-cheat: a perfect score finished impossibly fast looks automated.
          const elapsedSec = (Date.now() - new Date(play.startedAt).getTime()) / 1000;
          if (play.correctCount >= TOTAL_QUESTIONS && elapsedSec < FAST_COMPLETE_FLAG_SECONDS) {
            flagged = true;
          }
          await tx.quizDailyPlay.update({
            where: { id: play.id },
            data: { pointsEarned: { increment: completionBonus } },
          });
        }
      }

      // 4) Update the monthly score (drives leaderboard + winner selection).
      const totalAdd = points + completionBonus;
      await tx.quizMonthlyScore.upsert({
        where: { userId_period: { userId: user.id, period } },
        create: {
          userId: user.id,
          period,
          totalPoints: totalAdd,
          correctCount: isCorrect ? 1 : 0,
          lastEarnedAt: new Date(),
          flaggedForReview: flagged,
        },
        update: {
          totalPoints: { increment: totalAdd },
          correctCount: { increment: isCorrect ? 1 : 0 },
          ...(totalAdd > 0 ? { lastEarnedAt: new Date() } : {}),
          ...(flagged ? { flaggedForReview: true } : {}),
        },
      });

      return { isCorrect, points, completionBonus, completedNow };
    });
  } catch (e) {
    if (e?.code === 'P2002') return { error: 'ALREADY_ANSWERED' };
    throw e;
  }

   // If this user was referred and just finished a quiz day, check whether they
  // now hit the 30-day threshold. Best-effort — never affects the quiz reply.
  if (outcome.completedNow) {
    onQuizDayCompleted(user.id).catch((e) =>
      console.error('[referral] qualify failed:', e.message)
    );
  }

  return {
    correct: outcome.isCorrect,
    correctIndex: question.correctIndex, // safe to reveal AFTER the answer is recorded
    explanation: question.explanation,
    pointsAwarded: outcome.points,
    completionBonus: outcome.completionBonus,
    completed: outcome.completedNow,
  };
}

// --- leaderboard / my status -------------------------------------------------

export async function getLeaderboard(user, { limit = 20 } = {}) {
  const period = periodOf();
  const top = await prisma.quizMonthlyScore.findMany({
    where: { period, totalPoints: { gt: 0 } },
    orderBy: [{ totalPoints: 'desc' }, { lastEarnedAt: 'asc' }],
    take: limit,
    include: { user: { select: { id: true, name: true } } },
  });
  const items = top.map((s, i) => ({
    rank: i + 1,
    name: s.user.name || 'Learner',
    points: s.totalPoints,
    isMe: s.user.id === user.id,
  }));

  // The caller's own rank, even if outside the top N.
  const me = await prisma.quizMonthlyScore.findUnique({
    where: { userId_period: { userId: user.id, period } },
    select: { totalPoints: true, lastEarnedAt: true },
  });
  let myRank = null;
  if (me) {
    const ahead = await prisma.quizMonthlyScore.count({
      where: {
        period,
        OR: [
          { totalPoints: { gt: me.totalPoints } },
          { totalPoints: me.totalPoints, lastEarnedAt: { lt: me.lastEarnedAt } },
        ],
      },
    });
    myRank = ahead + 1;
  }

  return {
    period,
    items,
    me: me ? { rank: myRank, points: me.totalPoints } : { rank: null, points: 0 },
  };
}

export async function getMyQuizStatus(user) {
  const period = periodOf();
  const today = startOfUtcDay();
  const targetLanguage = user.targetLanguage || 'en';

  const [score, u, pendingWin, quiz] = await Promise.all([
    prisma.quizMonthlyScore.findUnique({
      where: { userId_period: { userId: user.id, period } },
      select: { totalPoints: true, correctCount: true },
    }),
    prisma.user.findUnique({
      where: { id: user.id },
      select: { quizCurrentStreak: true, quizLongestStreak: true },
    }),
    prisma.monthlyWinner.findFirst({
      where: { userId: user.id, status: 'OFFERED' },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.dailyQuiz.findUnique({
      where: { date_targetLanguage: { date: today, targetLanguage } },
      select: { id: true },
    }),
  ]);

  let play = null;
  if (quiz) {
    play = await prisma.quizDailyPlay.findUnique({
      where: { userId_quizId: { userId: user.id, quizId: quiz.id } },
      select: { answeredCount: true, correctCount: true, completedAt: true },
    });
  }

  return {
    period,
    monthlyPoints: score?.totalPoints || 0,
    monthlyCorrect: score?.correctCount || 0,
    streak: u?.quizCurrentStreak || 0,
    longestStreak: u?.quizLongestStreak || 0,
    today: {
      answered: play?.answeredCount || 0,
      correct: play?.correctCount || 0,
      completed: !!play?.completedAt,
      total: TOTAL_QUESTIONS,
    },
    // If set, this user is the month's top scorer and has an interview
    // opportunity waiting to be accepted.
    claimableOffer: pendingWin
      ? { id: pendingWin.id, period: pendingWin.period, status: pendingWin.status }
      : null,
  };
}

// --- winner selection (admin or cron) ---------------------------------------

// Pick the single top scorer for a finished month. Idempotent: the unique
// period on MonthlyWinner means it can't be selected twice. The reward is an
// interview / work-from-home opportunity (no physical prize).
export async function selectWinner(period, { note } = {}) {
  const top = await prisma.quizMonthlyScore.findFirst({
    where: { period, totalPoints: { gt: 0 } },
    orderBy: [{ totalPoints: 'desc' }, { lastEarnedAt: 'asc' }],
  });
  if (!top) return { error: 'NO_PARTICIPANTS' };

  // If the top scorer was flagged by anti-cheat, hold for manual review before
  // the opportunity is offered.
  const status = top.flaggedForReview ? 'PENDING_REVIEW' : 'OFFERED';
  try {
    const winner = await prisma.monthlyWinner.create({
      data: {
        period,
        userId: top.userId,
        totalPoints: top.totalPoints,
        status,
        flaggedForReview: top.flaggedForReview,
        note: note || null,
      },
      include: { user: { select: { id: true, name: true, email: true } } },
    });
    return { winner, needsReview: top.flaggedForReview };
  } catch (e) {
    if (e?.code === 'P2002') return { error: 'ALREADY_SELECTED' };
    throw e;
  }
}

export async function approveWinner(winnerId) {
  const w = await prisma.monthlyWinner.findUnique({ where: { id: winnerId } });
  if (!w) return { error: 'NOT_FOUND' };
  if (w.status !== 'PENDING_REVIEW') return { error: 'NOT_PENDING_REVIEW' };
  const winner = await prisma.monthlyWinner.update({
    where: { id: winnerId },
    data: { status: 'OFFERED' },
  });
  return { winner };
}

export async function listWinners() {
  return prisma.monthlyWinner.findMany({
    orderBy: { createdAt: 'desc' },
    include: { user: { select: { id: true, name: true, email: true } } },
  });
}

export async function updateWinnerStatus(winnerId, status) {
  const allowed = ['OFFERED', 'ACCEPTED', 'CLOSED', 'CANCELED'];
  if (!allowed.includes(status)) return { error: 'BAD_STATUS' };
  const winner = await prisma.monthlyWinner.update({
    where: { id: winnerId },
    data: { status },
  });
  return { winner };
}

// --- winner accepts the interview opportunity -------------------------------

export async function getClaimableWinner(user) {
  return prisma.monthlyWinner.findFirst({
    where: { userId: user.id, status: { in: ['OFFERED', 'ACCEPTED'] } },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      period: true,
      status: true,
      totalPoints: true,
      preferredRole: true,
      acceptedAt: true,
    },
  });
}

// The winner accepts and tells us how to reach them + which post they want.
export async function acceptOffer(user, { contactPhone, preferredRole, note }) {
  const winner = await prisma.monthlyWinner.findFirst({
    where: { userId: user.id, status: 'OFFERED' },
    orderBy: { createdAt: 'desc' },
  });
  if (!winner) return { error: 'NO_OFFER' };

  const updated = await prisma.monthlyWinner.update({
    where: { id: winner.id },
    data: {
      contactPhone,
      preferredRole: preferredRole || null,
      note: note || winner.note || null,
      status: 'ACCEPTED',
      acceptedAt: new Date(),
    },
    select: { id: true, period: true, status: true, preferredRole: true },
  });
  return { winner: updated };
}

// --- void a bad AI question (refunds points so the contest stays fair) -------

export async function voidQuestion(questionId) {
  return prisma.$transaction(async (tx) => {
    const q = await tx.quizQuestion.findUnique({ where: { id: questionId } });
    if (!q) return { error: 'NOT_FOUND' };
    if (q.voided) return { ok: true, alreadyVoided: true, refundedUsers: 0 };

    await tx.quizQuestion.update({ where: { id: questionId }, data: { voided: true } });

    const answers = await tx.quizAnswer.findMany({
      where: { questionId, pointsAwarded: { gt: 0 } },
      select: { id: true, userId: true, pointsAwarded: true, answeredAt: true },
    });
    for (const a of answers) {
      const period = periodOf(a.answeredAt);
      await tx.quizMonthlyScore.updateMany({
        where: { userId: a.userId, period },
        data: { totalPoints: { decrement: a.pointsAwarded }, correctCount: { decrement: 1 } },
      });
      await tx.quizAnswer.update({
        where: { id: a.id },
        data: { pointsAwarded: 0, isCorrect: false },
      });
    }
    return { ok: true, refundedUsers: answers.length };
  });
}
