import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { generateCard } from '../services/ai.service.js';
import { synthesizeSpeech } from '../services/tts.service.js';
import { touchStreak } from '../services/streak.service.js';
import { notifyNewCard } from '../services/notification.service.js';

import { saveBuffer } from '../services/storage.service.js';

import { summarizeArticle } from '../services/ai.service.js';

import { adminArticleVocabSchema } from '../validators/schemas.js';
import { sniffImageExt } from '../utils/imageType.js';

function countWords(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// GET /cards/feed — the Inshorts-style daily feed for the user's target language.
// Logged-in users see UNSEEN cards first, then SEEN ones as a fallback so the
// feed is never empty (a card becomes "seen" via POST /cards/:id/seen). Guests
// get plain newest-first with cursor pagination.
const FEED_CARD_SELECT = {
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
};

function clampLimit(raw) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return 20;
  return Math.min(50, Math.max(1, n)); // 1..50, default 20
}

// GET /cards/feed — chronological (newest-first) cursor feed for guests AND
// logged-in users, so it scrolls "infinitely" until the oldest card. Logged-in
// responses are annotated with per-user progress + saved for the page only.
export const getFeed = asyncHandler(async (req, res) => {
  const limit = clampLimit(req.query.limit);
  const cursor = req.query.cursor || null;
  const { level } = req.query;

  const where = {
    targetLanguage: req.user?.targetLanguage || 'en',
    isPublished: true,
    ...(level ? { level } : {}),
  };
  // Stable, unique ordering is required for cursor paging (id breaks createdAt ties).
  const orderBy = [{ createdAt: 'desc' }, { id: 'desc' }];

  // Fetch one extra row to know whether another page exists.
  const rows = await prisma.card.findMany({
    where,
    orderBy,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    select: FEED_CARD_SELECT,
  });
  const hasMore = rows.length > limit;
  if (hasMore) rows.pop();
  const nextCursor = hasMore ? rows[rows.length - 1].id : null;

  // Guests: no per-user state.
  if (!req.user) {
    return res.json({
      items: rows.map((c) => ({ ...c, progress: null, saved: false })),
      nextCursor,
    });
  }

  // Logged-in: annotate progress + saved for just this page (<= limit rows).
  const uid = req.user.id;
  const ids = rows.map((c) => c.id);
  const [seenRows, savedRows] = await Promise.all([
    prisma.cardCompletion.findMany({
      where: { userId: uid, cardId: { in: ids } },
      select: { cardId: true, readDone: true, listenDone: true },
    }),
    prisma.savedCard.findMany({
      where: { userId: uid, cardId: { in: ids } },
      select: { cardId: true },
    }),
  ]);
  const seenMap = new Map(seenRows.map((r) => [r.cardId, r]));
  const savedSet = new Set(savedRows.map((s) => s.cardId));

  res.json({
    items: rows.map((c) => ({
      ...c,
      progress: seenMap.get(c.id) || null,
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
      ...(req.user ? { savedBy: { where: { userId: req.user.id }, select: { id: true } } } : {}),
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

// POST /cards/:id/seen — record that the user has VIEWED this card (they dwelled
// on it long enough in the feed). Deliberately separate from /complete: it does
// NOT bump the streak, because passive viewing shouldn't earn a streak. Its only
// job is to feed the "unseen first, then seen" ordering in getFeed. Idempotent.
export const markCardSeen = asyncHandler(async (req, res) => {
  const card = await prisma.card.findUnique({
    where: { id: req.params.id },
    select: { id: true, isPublished: true },
  });
  if (!card || !card.isPublished) throw ApiError.notFound('Card not found');

  await prisma.cardCompletion.upsert({
    where: { userId_cardId: { userId: req.user.id, cardId: card.id } },
    create: { userId: req.user.id, cardId: card.id, readDone: true },
    update: {},
  });

  res.json({ success: true });
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
  if (!req.file) throw ApiError.badRequest('An image file is required (field "image")');

  const imgExt = sniffImageExt(req.file.buffer);
  if (!imgExt) throw ApiError.badRequest('Uploaded file is not a supported image', 'BAD_IMAGE');

  const targetLanguage = req.body.targetLanguage || 'en';
  const nativeLanguage = req.body.nativeLanguage || 'hi';
  const level = req.body.level || 'INTERMEDIATE';
  const sourceUrl = req.body.sourceUrl?.trim() || null;
  const publish =
    req.body.publish === undefined
      ? true
      : req.body.publish === true || req.body.publish === 'true';

  const summarized = await summarizeArticle({
    text: req.body.text,
    targetLanguage,
    nativeLanguage,
  });
  const title = (req.body.title && req.body.title.trim()) || summarized.title;

  const { url: imageUrl } = await saveBuffer(req.file.buffer, {
    folder: 'images',
    ext: imgExt,
  });

  const card = await prisma.card.create({
    data: {
      targetLanguage,
      level,
      topic: 'news',
      title,
      body: summarized.body,
      wordCount: countWords(summarized.body),
      imageUrl,
      sourceUrl,
      isPublished: publish,
      vocab: summarized.vocab?.length
        ? {
            create: summarized.vocab.map((v) => ({
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

  await generateAndAttachAudio(card.id, summarized.body, targetLanguage);
  if (card.isPublished) await notifyNewCard(card);

  const fresh = await prisma.card.findUnique({ where: { id: card.id }, include: { vocab: true } });
  res.status(201).json(fresh);
});

// POST /cards/admin-article — admin WRITES the full article (title/body/vocab)
// and uploads a hero image. No AI: the admin authors everything; we store the
// image, create the card, synthesize audio (listen/speak), and publish. This is
// the hand-written twin of createArticleFromNews (which AI-summarizes a story).
export const createAdminArticle = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('An image file is required (field "image")');

  const imgExt = sniffImageExt(req.file.buffer);
  if (!imgExt) throw ApiError.badRequest('Uploaded file is not a supported image', 'BAD_IMAGE');

  const targetLanguage = req.body.targetLanguage || 'en';
  const nativeLanguage = req.body.nativeLanguage || 'hi';
  const level = req.body.level || 'INTERMEDIATE';
  const topic = req.body.topic?.trim() || 'article';
  const sourceUrl = req.body.sourceUrl?.trim() || null;
  const publish =
    req.body.publish === undefined
      ? true
      : req.body.publish === true || req.body.publish === 'true';

  // vocab is optional and arrives as a JSON string in the multipart form.
  let vocab = [];
  if (req.body.vocab) {
    let parsed;
    try {
      parsed = JSON.parse(req.body.vocab);
    } catch {
      throw ApiError.badRequest('"vocab" must be valid JSON (an array of entries)', 'BAD_VOCAB');
    }
    const result = adminArticleVocabSchema.safeParse(parsed);
    if (!result.success) throw ApiError.badRequest('Invalid vocab entries', 'BAD_VOCAB');
    vocab = result.data;
  }

  const { url: imageUrl } = await saveBuffer(req.file.buffer, {
    folder: 'images',
    ext: imgExt,
  });

  const card = await prisma.card.create({
    data: {
      targetLanguage,
      level,
      topic,
      title: req.body.title.trim(),
      body: req.body.body,
      wordCount: countWords(req.body.body),
      imageUrl,
      sourceUrl,
      isPublished: publish,
      vocab: vocab.length
        ? {
            create: vocab.map((v) => ({
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

  await generateAndAttachAudio(card.id, req.body.body, targetLanguage);
  if (card.isPublished) await notifyNewCard(card);

  const fresh = await prisma.card.findUnique({ where: { id: card.id }, include: { vocab: true } });
  res.status(201).json(fresh);
});

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
// GET /cards/saved — list the user's bookmarked cards, newest first (paginated).
export const listSavedCards = asyncHandler(async (req, res) => {
  const limit = req.query.limit ?? 20;
  const cursor = req.query.cursor;
  const saved = await prisma.savedCard.findMany({
    where: { userId: req.user.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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

  let nextCursor = null;
  if (saved.length > limit) {
    const next = saved.pop();
    nextCursor = next.id;
  }

  res.json({
    items: saved.map((s) => ({ ...s.card, saved: true, savedAt: s.createdAt })),
    nextCursor,
  });
});
