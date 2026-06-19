import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

export const getProgress = asyncHandler(async (req, res) => {
  const totalWords = await prisma.vocabWord.count();
  const counts = await prisma.vocabWord.groupBy({ by: ['ladder'], _count: { _all: true } });
  const totalByLadder = {};
  for (const c of counts) totalByLadder[c.ladder] = c._count._all;

  const learned = await prisma.vocabProgress.findMany({
    where: { userId: req.user.id },
    select: { word: { select: { ladder: true } } },
  });
  const learnedByLadder = {};
  for (const p of learned) learnedByLadder[p.word.ladder] = (learnedByLadder[p.word.ladder] || 0) + 1;

  const totalLadders = Object.keys(totalByLadder).length;
  const ladders = [];
  let prevComplete = true;
  for (let n = 1; n <= totalLadders; n++) {
    const total = totalByLadder[n] || 0;
    const learnedN = learnedByLadder[n] || 0;
    const complete = total > 0 && learnedN >= total;
    const unlocked = n === 1 || prevComplete;
    ladders.push({ ladder: n, total, learned: learnedN, unlocked, complete });
    prevComplete = complete;
  }
  const currentLadder = ladders.find((l) => l.unlocked && !l.complete)?.ladder || totalLadders;
  res.json({ totalWords, learnedCount: learned.length, currentLadder, ladders });
});

export const getLadder = asyncHandler(async (req, res) => {
  const n = parseInt(req.params.n, 10);
  if (!n || n < 1) throw ApiError.badRequest('Invalid ladder');

  if (n > 1) {
    const prevTotal = await prisma.vocabWord.count({ where: { ladder: n - 1 } });
    const prevLearned = await prisma.vocabProgress.count({ where: { userId: req.user.id, word: { ladder: n - 1 } } });
    if (prevTotal > 0 && prevLearned < prevTotal) throw ApiError.forbidden('Finish the previous ladder first', 'LADDER_LOCKED');
  }

  const words = await prisma.vocabWord.findMany({ where: { ladder: n }, orderBy: { rank: 'asc' } });
  const learnedIds = new Set(
    (await prisma.vocabProgress.findMany({ where: { userId: req.user.id, word: { ladder: n } }, select: { wordId: true } })).map((p) => p.wordId)
  );
  res.json({
    ladder: n,
    words: words.map((w) => ({
      id: w.id, word: w.word, partOfSpeech: w.partOfSpeech, meaning: w.meaning,
      translation: w.translation, example: w.example, learned: learnedIds.has(w.id),
    })),
  });
});

export const learnWord = asyncHandler(async (req, res) => {
  const word = await prisma.vocabWord.findUnique({ where: { id: req.params.id } });
  if (!word) throw ApiError.notFound('Word not found');
  await prisma.vocabProgress.upsert({
    where: { userId_wordId: { userId: req.user.id, wordId: word.id } },
    create: { userId: req.user.id, wordId: word.id },
    update: {},
  });
  res.json({ learned: true });
});

export const completeLadder = asyncHandler(async (req, res) => {
  const n = parseInt(req.params.n, 10);
  if (!n || n < 1) throw ApiError.badRequest('Invalid ladder');

  // Same gate as getLadder: a ladder can only be completed once the previous
  // one is finished, so the bulk-complete endpoint can't skip the progression.
  if (n > 1) {
    const prevTotal = await prisma.vocabWord.count({ where: { ladder: n - 1 } });
    const prevLearned = await prisma.vocabProgress.count({
      where: { userId: req.user.id, word: { ladder: n - 1 } },
    });
    if (prevTotal > 0 && prevLearned < prevTotal) {
      throw ApiError.forbidden('Finish the previous ladder first', 'LADDER_LOCKED');
    }
  }

  const words = await prisma.vocabWord.findMany({ where: { ladder: n }, select: { id: true } });
  await prisma.$transaction(
    words.map((w) =>
      prisma.vocabProgress.upsert({
        where: { userId_wordId: { userId: req.user.id, wordId: w.id } },
        create: { userId: req.user.id, wordId: w.id },
        update: {},
      })
    )
  );
  res.json({ completed: true, count: words.length });
});