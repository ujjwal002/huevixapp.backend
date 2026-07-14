import { prisma } from '../db/prisma.js';
import { ApiError } from '../utils/ApiError.js';
import { isSubscriptionActive } from './entitlement.service.js';
import { applyAnswer, freshlyTaught } from './vocabTutor.logic.js';

import { synthesizeWordAudio } from './tts.service.js';

// The tutor is a premium feature. Loads the subscription if needed and throws
// a 402 paywall when the user isn't an active subscriber.
export async function assertSubscribed(user) {
  let u = user;
  if (u.subscription === undefined) {
    u = await prisma.user.findUnique({ where: { id: user.id }, include: { subscription: true } });
  }
  if (!isSubscriptionActive(u)) {
    throw new ApiError(
      402,
      'The AI vocab tutor is a premium feature. Subscribe to unlock it.',
      'PAYWALL'
    );
  }
  return u;
}

// The next `n` words (by ladder, then rank) the user hasn't started yet.
export async function pickNewWordIds(userId, n) {
  const learned = await prisma.vocabProgress.findMany({
    where: { userId },
    select: { wordId: true },
  });
  const learnedIds = learned.map((p) => p.wordId);
  const words = await prisma.vocabWord.findMany({
    where: learnedIds.length ? { id: { notIn: learnedIds } } : {},
    orderBy: [{ ladder: 'asc' }, { rank: 'asc' }],
    take: n,
    select: { id: true },
  });
  return words.map((w) => w.id);
}

export async function loadProgressForSelection(userId) {
  return prisma.vocabProgress.findMany({
    where: { userId },
    select: { wordId: true, strength: true, dueAt: true },
  });
}

export async function countLearned(userId) {
  return prisma.vocabProgress.count({ where: { userId } });
}

export async function getWord(wordId) {
  if (!wordId) return null;
  return prisma.vocabWord.findUnique({ where: { id: wordId } });
}

// Lazily generate + cache the English audio (word + example) for a word; reused
// across all users, so each word costs TTS at most once. Returns the url (or
// null if it couldn't be produced — the turn still proceeds without it).
export async function ensureWordAudio(word) {
  if (!word) return null;
  if (word.audioUrl) return word.audioUrl;
  const text = word.example ? `${word.word}. ${word.example}` : word.word;
  try {
    const { url } = await synthesizeWordAudio(text);
    await prisma.vocabWord.update({ where: { id: word.id }, data: { audioUrl: url } });
    return url;
  } catch {
    return null;
  }
}

// Persist a quiz result through the SRS rules (promote/demote, due date).
export async function recordAnswer(userId, wordId, correct, now = new Date()) {
  const prev = await prisma.vocabProgress.findUnique({
    where: { userId_wordId: { userId, wordId } },
  });
  const data = applyAnswer(prev, correct, now);
  await prisma.vocabProgress.upsert({
    where: { userId_wordId: { userId, wordId } },
    create: { userId, wordId, ...data },
    update: data,
  });
}

// Mark a freshly-taught word as learned (idempotent: never downgrades a word
// the user already has progress on).
export async function recordTaught(userId, wordId, now = new Date()) {
  const exists = await prisma.vocabProgress.findUnique({
    where: { userId_wordId: { userId, wordId } },
    select: { id: true },
  });
  if (exists) return;
  await prisma.vocabProgress.create({ data: { userId, wordId, ...freshlyTaught(now) } });
}
