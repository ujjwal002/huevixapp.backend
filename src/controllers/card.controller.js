import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { generateCard } from '../services/ai.service.js';
import { synthesizeSpeech } from '../services/tts.service.js';
import { touchStreak } from '../services/streak.service.js';
import { notifyNewCard } from '../services/notification.service.js';

import { saveBuffer } from '../services/storage.service.js';


import {summarizeArticle} from '../services/ai.service.js';

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// GET /cards/feed — the Inshorts-style daily feed for the user's target language.
export const getFeed = asyncHandler(async (req, res) => {
  const { level, cursor, limit } = req.query;
  const where = {
    targetLanguage: req.user?.targetLanguage || 'en',
    isPublished: true,
    ...(level ? { level } : {}),
  };

  const cards = await prisma.card.findMany({
    where,
    // Fix #10: cursor pagination needs a stable, unique ordering. Adding `id`
    // as a tiebreaker prevents skipped/duplicated cards when two share a
    // createdAt (e.g. batch-seeded or AI-generated in the same millisecond).
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: {
      id: true,
      title: true,
      body: true,
      level: true,
      topic: true,
      targetLanguage: true,
      audioUrl: true,
      audioStatus: true,
      wordCount: true,
      imageUrl: true,
      sourceUrl: true,
      createdAt: true,
    },
  });

  let nextCursor = null;
  if (cards.length > limit) {
    const next = cards.pop();
    nextCursor = next.id;
  }

  // For logged-in users, attach completed + saved status. Guests skip this.
  let doneMap = new Map();
  let savedSet = new Set();
  if (req.user) {
    const ids = cards.map((c) => c.id);
    const [done, saved] = await Promise.all([
      prisma.cardCompletion.findMany({
        where: { userId: req.user.id, cardId: { in: ids } },
        select: { cardId: true, readDone: true, listenDone: true },
      }),
      prisma.savedCard.findMany({
        where: { userId: req.user.id, cardId: { in: ids } },
        select: { cardId: true },
      }),
    ]);
    doneMap = new Map(done.map((d) => [d.cardId, d]));
    savedSet = new Set(saved.map((s) => s.cardId));
  }

  res.json({
    items: cards.map((c) => ({
      ...c,
      progress: doneMap.get(c.id) || null,
      saved: savedSet.has(c.id),
    })),
    nextCursor,
  });
});

// GET /cards/:id — full card with vocab in the user's native language.
export const getCard = asyncHandler(async (req, res) => {
  const card = await prisma.card.findUnique({
    where: { id: req.params.id },
    include: {
      vocab: {
        where: { nativeLanguage: req.user?.nativeLanguage || 'hi' },
        select: { term: true, partOfSpeech: true, meaning: true, example: true },
      },
      ...(req.user
        ? { savedBy: { where: { userId: req.user.id }, select: { id: true } } }
        : {}),
    },
  });
  if (!card || !card.isPublished) throw ApiError.notFound('Card not found');

  res.json({
    id: card.id,
    title: card.title,
    body: card.body,
    level: card.level,
    topic: card.topic,
    targetLanguage: card.targetLanguage,
    audioUrl: card.audioUrl,
    audioStatus: card.audioStatus,
    wordCount: card.wordCount,
    saved: req.user ? (card.savedBy?.length || 0) > 0 : false,
    vocab: card.vocab, // meanings already in the user's native language
    imageUrl: card.imageUrl,
    sourceUrl: card.sourceUrl,
  });
});

// POST /cards/:id/complete — mark read/listen done; updates streak once/day.
export const completeCard = asyncHandler(async (req, res) => {
  const card = await prisma.card.findUnique({ where: { id: req.params.id } });
  if (!card || !card.isPublished) throw ApiError.notFound('Card not found');

  const readDone = req.body?.readDone !== false;
  const listenDone = req.body?.listenDone === true;

  await prisma.cardCompletion.upsert({
    where: { userId_cardId: { userId: req.user.id, cardId: card.id } },
    create: { userId: req.user.id, cardId: card.id, readDone, listenDone },
    update: {
      readDone: readDone || undefined,
      listenDone: listenDone || undefined,
      completedAt: new Date(),
    },
  });

  const streak = await touchStreak(req.user.id);
  res.json({ success: true, streak });
});

// ----------------------------- Admin -------------------------------------

// POST /cards — manually create a card (+ optional vocab) and generate audio.
export const createCard = asyncHandler(async (req, res) => {
  const { targetLanguage, level, topic, title, body, publish, vocab } = req.body;

  const card = await prisma.card.create({
    data: {
      targetLanguage,
      level,
      topic,
      title,
      body,
      wordCount: countWords(body),
      isPublished: publish,
      vocab: vocab?.length ? { create: vocab } : undefined,
    },
  });

  await generateAndAttachAudio(card.id, body, targetLanguage);
  if (card.isPublished) await notifyNewCard(card);
  const fresh = await prisma.card.findUnique({ where: { id: card.id } });
  res.status(201).json(fresh);
});

// POST /cards/generate — AI-generate a card + vocab, then synthesize audio.
export const generateAndCreateCard = asyncHandler(async (req, res) => {
  const { targetLanguage, nativeLanguage, level, topic, publish } = req.body;

  const generated = await generateCard({ targetLanguage, nativeLanguage, level, topic });

  const card = await prisma.card.create({
    data: {
      targetLanguage,
      level,
      topic,
      title: generated.title,
      body: generated.body,
      wordCount: countWords(generated.body),
      isPublished: publish,
      vocab: generated.vocab?.length
        ? {
          create: generated.vocab.map((v) => ({
            nativeLanguage,
            term: v.term,
            partOfSpeech: v.partOfSpeech,
            meaning: v.meaning,
            example: v.example,
          })),
        }
        : undefined,
    },
  });

  await generateAndAttachAudio(card.id, generated.body, targetLanguage);
  if (card.isPublished) await notifyNewCard(card);
  const fresh = await prisma.card.findUnique({
    where: { id: card.id },
    include: { vocab: true },
  });
  res.status(201).json(fresh);
});

// POST /cards/article — admin pastes a news article + uploads an image; AI
// summarizes it (natural level) + extracts complex vocab; we store the image,
// create the article card, and synthesize audio for listen + speak.
export const createArticleFromNews = asyncHandler(async (req, res) => {

  console.log('Received article creation request with body:', req.body);
  if (!req.file) throw ApiError.badRequest('An image file is required (field "image")');

  const targetLanguage = req.body.targetLanguage || 'en';
  const nativeLanguage = req.body.nativeLanguage || 'hi';
  const level = req.body.level || 'INTERMEDIATE';
  const sourceUrl = req.body.sourceUrl?.trim() || null;
  const publish =
    req.body.publish === undefined ? true : req.body.publish === true || req.body.publish === 'true';

  const summarized = await summarizeArticle({ text: req.body.text, targetLanguage, nativeLanguage });
  const title = (req.body.title && req.body.title.trim()) || summarized.title;

  const { url: imageUrl } = await saveBuffer(req.file.buffer, {
    folder: 'images',
    ext: imageExt(req.file.mimetype),
  });

  const card = await prisma.card.create({
    data: {
      targetLanguage, level, topic: 'news', title,
      body: summarized.body,
      wordCount: countWords(summarized.body),
      imageUrl, sourceUrl, isPublished: publish,
      vocab: summarized.vocab?.length
        ? { create: summarized.vocab.map((v) => ({
            nativeLanguage, term: v.term, partOfSpeech: v.partOfSpeech, meaning: v.meaning, example: v.example,
          })) }
        : undefined,
    },
  });

  await generateAndAttachAudio(card.id, summarized.body, targetLanguage);
  if (card.isPublished) await notifyNewCard(card);

  const fresh = await prisma.card.findUnique({ where: { id: card.id }, include: { vocab: true } });
  res.status(201).json(fresh);
});

function imageExt(mimetype) {
  const map = { 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/gif': 'gif' };
  return map[(mimetype || '').toLowerCase()] || 'jpg';
}

// Helper: synthesize TTS once and cache the URL on the card.
async function generateAndAttachAudio(cardId, text, targetLanguage) {
  try {
    const { url } = await synthesizeSpeech({ text, targetLanguage });
    await prisma.card.update({
      where: { id: cardId },
      data: { audioUrl: url, audioStatus: 'READY' },
    });
  } catch (err) {
    console.error('[TTS] generation failed', err.message);
    await prisma.card.update({
      where: { id: cardId },
      data: { audioStatus: 'FAILED' },
    });
  }
}

// ----------------------------- Saved cards -------------------------------

// POST /cards/:id/save — bookmark a card (idempotent).
export const saveCard = asyncHandler(async (req, res) => {
  const card = await prisma.card.findUnique({ where: { id: req.params.id } });
  if (!card || !card.isPublished) throw ApiError.notFound('Card not found');

  await prisma.savedCard.upsert({
    where: { userId_cardId: { userId: req.user.id, cardId: card.id } },
    create: { userId: req.user.id, cardId: card.id },
    update: {},
  });
  res.json({ saved: true });
});

// DELETE /cards/:id/save — remove a bookmark (idempotent).
export const unsaveCard = asyncHandler(async (req, res) => {
  await prisma.savedCard.deleteMany({
    where: { userId: req.user.id, cardId: req.params.id },
  });
  res.json({ saved: false });
});

// GET /cards/saved — list the user's bookmarked cards, newest first.
export const listSavedCards = asyncHandler(async (req, res) => {
  const saved = await prisma.savedCard.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: {
      card: {
        select: {
          id: true,
          title: true,
          body: true,
          level: true,
          topic: true,
          targetLanguage: true,
          audioUrl: true,
          audioStatus: true,
          wordCount: true,
          imageUrl: true,
          sourceUrl: true,
        },
      },
    },
  });
  res.json({
    items: saved.map((s) => ({ ...s.card, saved: true, savedAt: s.createdAt })),
  });
});