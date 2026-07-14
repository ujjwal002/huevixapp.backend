import { prisma } from '../db/prisma.js';
import { startOfUtcDay } from '../utils/dates.js';
import { generateDailyVocab, DAILY_VOCAB_WORD_COUNT } from './vocabAi.service.js';

function utcDayStart(d = new Date()) {
  return startOfUtcDay(d);
}

// Gather recently-used words so the generator doesn't repeat them.
async function recentWords(limit = 400) {
  const rows = await prisma.vocabSetWord.findMany({
    select: { word: true },
    orderBy: { id: 'desc' },
    take: limit,
  });
  return rows.map((r) => r.word);
}

// Get today's set, generating it (once) if missing. Race-safe: the unique
// (date, targetLanguage) index means a concurrent create loses and we re-read.
export async function getOrCreateTodaySet(targetLanguage = 'en') {
  const date = utcDayStart();
  const existing = await prisma.dailyVocabSet.findUnique({
    where: { date_targetLanguage: { date, targetLanguage } },
    include: { words: { orderBy: { order: 'asc' } } },
  });
  if (existing) return existing;

  const avoid = await recentWords();
  const items = await generateDailyVocab({ avoidWords: avoid });

  try {
    await prisma.dailyVocabSet.create({
      data: {
        date,
        targetLanguage,
        words: {
          create: items.slice(0, DAILY_VOCAB_WORD_COUNT).map((it, i) => ({
            order: i,
            word: it.word,
            partOfSpeech: it.partOfSpeech,
            meaning: it.meaning,
            example: it.example,
            questionSentence: it.question.sentence,
            options: it.question.options,
            correctIndex: it.question.correctIndex,
          })),
        },
      },
    });
  } catch {
    // Likely a concurrent create won the unique race — fall through to re-read.
  }

  return prisma.dailyVocabSet.findUnique({
    where: { date_targetLanguage: { date, targetLanguage } },
    include: { words: { orderBy: { order: 'asc' } } },
  });
}

// Shape today's set for a user — NEVER sends correctIndex. Marks which words the
// user has already answered (for resume), and includes their play state.
export async function getTodaySetForUser(user, targetLanguage = 'en') {
  const set = await getOrCreateTodaySet(targetLanguage);
  if (!set) return null;

  const answers = await prisma.vocabSetAnswer.findMany({
    where: { userId: user.id, wordId: { in: set.words.map((w) => w.id) } },
    select: { wordId: true, chosenIndex: true, correct: true },
  });
  const byWord = new Map(answers.map((a) => [a.wordId, a]));

  return {
    setId: set.id,
    date: set.date,
    targetLanguage: set.targetLanguage,
    totalWords: set.words.length,
    words: set.words.map((w) => {
      const a = byWord.get(w.id);
      return {
        id: w.id,
        order: w.order,
        word: w.word,
        partOfSpeech: w.partOfSpeech,
        meaning: w.meaning,
        example: w.example,
        // practice question — options WITHOUT the correct index
        question: {
          sentence: w.questionSentence,
          options: w.options,
        },
        answered: !!a,
        yourChoice: a ? a.chosenIndex : null,
        wasCorrect: a ? a.correct : null,
      };
    }),
  };
}

async function bumpVocabStreak(tx, userId, today) {
  const u = await tx.user.findUnique({
    where: { id: userId },
    select: { vocabCurrentStreak: true, vocabLongestStreak: true, vocabLastPlayedDate: true },
  });
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const last = u?.vocabLastPlayedDate ? utcDayStart(u.vocabLastPlayedDate) : null;

  let streak;
  if (last && last.getTime() === today.getTime()) streak = u.vocabCurrentStreak || 1;
  else if (last && last.getTime() === yesterday.getTime()) streak = (u.vocabCurrentStreak || 0) + 1;
  else streak = 1;

  const longest = Math.max(u?.vocabLongestStreak || 0, streak);
  await tx.user.update({
    where: { id: userId },
    data: { vocabCurrentStreak: streak, vocabLongestStreak: longest, vocabLastPlayedDate: today },
  });
  return streak;
}

// Submit one practice answer. One-shot per (user, word). Returns correctness +
// the correctIndex (safe to reveal AFTER answering) + explanation-ish example.
export async function submitVocabAnswer(user, { wordId, chosenIndex }) {
  const word = await prisma.vocabSetWord.findUnique({
    where: { id: wordId },
    include: { set: true },
  });
  if (!word) return { error: 'NOT_FOUND' };

  const today = utcDayStart();
  if (utcDayStart(word.set.date).getTime() !== today.getTime()) return { error: 'NOT_TODAY' };

  const optionCount = Array.isArray(word.options) ? word.options.length : 0;
  if (!Number.isInteger(chosenIndex) || chosenIndex < 0 || chosenIndex >= optionCount) {
    return { error: 'BAD_CHOICE' };
  }

  const correct = chosenIndex === word.correctIndex;

  let completedNow = false;
  let streak = null;
  try {
    await prisma.$transaction(async (tx) => {
      // 1) Record the answer — unique(userId, wordId) makes it one-shot.
      await tx.vocabSetAnswer.create({
        data: { userId: user.id, wordId, chosenIndex, correct },
      });

      // 2) Update daily play counters.
      const play = await tx.vocabDailyPlay.upsert({
        where: { userId_setId: { userId: user.id, setId: word.setId } },
        create: { userId: user.id, setId: word.setId, correctCount: correct ? 1 : 0 },
        update: { correctCount: { increment: correct ? 1 : 0 } },
      });

      // 3) How many has the user answered in this set now?
      const answeredCount = await tx.vocabSetAnswer.count({
        where: { userId: user.id, word: { setId: word.setId } },
      });

      // 4) On the final answer, mark complete + bump streak EXACTLY once.
      if (answeredCount >= word.set.words?.length || answeredCount >= DAILY_VOCAB_WORD_COUNT) {
        const claim = await tx.vocabDailyPlay.updateMany({
          where: { id: play.id, completedAt: null },
          data: { completedAt: new Date() },
        });
        if (claim.count === 1) {
          completedNow = true;
          streak = await bumpVocabStreak(tx, user.id, today);
        }
      }
    });
  } catch (e) {
    if (e.code === 'P2002') return { error: 'ALREADY_ANSWERED' };
    throw e;
  }

  return {
    correct,
    correctIndex: word.correctIndex, // safe to reveal now
    example: word.example, // reinforce usage after answering
    completedNow,
    streak,
  };
}

// Lightweight status for the Learn card + streak display.
export async function getMyVocabStatus(user, targetLanguage = 'en') {
  const today = utcDayStart();
  const set = await prisma.dailyVocabSet.findUnique({
    where: { date_targetLanguage: { date: today, targetLanguage } },
    select: { id: true, _count: { select: { words: true } } },
  });

  let answeredToday = 0;
  let completed = false;
  if (set) {
    answeredToday = await prisma.vocabSetAnswer.count({
      where: { userId: user.id, word: { setId: set.id } },
    });
    const play = await prisma.vocabDailyPlay.findUnique({
      where: { userId_setId: { userId: user.id, setId: set.id } },
      select: { completedAt: true },
    });
    completed = !!play?.completedAt;
  }

  const u = await prisma.user.findUnique({
    where: { id: user.id },
    select: { vocabCurrentStreak: true, vocabLongestStreak: true, vocabLastPlayedDate: true },
  });
  // If they missed yesterday, the "current" streak is effectively broken for display.
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const last = u?.vocabLastPlayedDate ? utcDayStart(u.vocabLastPlayedDate) : null;
  const streakAlive =
    last && (last.getTime() === today.getTime() || last.getTime() === yesterday.getTime());

  return {
    totalWords: set?._count.words ?? DAILY_VOCAB_WORD_COUNT,
    answeredToday,
    completed,
    streak: streakAlive ? u?.vocabCurrentStreak || 0 : 0,
    longestStreak: u?.vocabLongestStreak || 0,
  };
}
