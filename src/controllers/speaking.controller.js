import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { assessPronunciation } from '../services/speech.service.js';
import { saveBuffer } from '../services/storage.service.js';
import {
  getSpeakingAccess,
  consumeSpeaking,
} from '../services/entitlement.service.js';
import { touchStreak } from '../services/streak.service.js';

// POST /cards/:id/speak  (multipart: field "audio")
// Reads the user's recording, scores it against the card text, stores the
// attempt, consumes an entitlement, and returns "what you did great / wrong".
export const submitSpeaking = asyncHandler(async (req, res) => {
  const card = await prisma.card.findUnique({ where: { id: req.params.id } });
  if (!card || !card.isPublished) throw ApiError.notFound('Card not found');

  if (!req.file) throw ApiError.badRequest('Audio file is required (field "audio")');

  // 1. Entitlement gate (free taste -> ad credits -> subscription -> paywall).
  const access = await getSpeakingAccess(req.user);
  if (!access.allowed) {
    throw ApiError.payment(access.message, access.reason);
  }

  // 2. Store the recording (optional but useful for review/debugging).
  const saved = await saveBuffer(req.file.buffer, {
    folder: 'recordings',
    ext: (req.file.mimetype?.split('/')[1] || 'wav').replace('x-wav', 'wav'),
  });

  // 3. Run pronunciation assessment against the reference text.
  const result = await assessPronunciation({
    audioBuffer: req.file.buffer,
    referenceText: card.body,
    targetLanguage: card.targetLanguage,
  });

  // 4. Persist the attempt.
  const attempt = await prisma.speakingAttempt.create({
    data: {
      userId: req.user.id,
      cardId: card.id,
      source: access.source,
      overallScore: result.overallScore,
      accuracyScore: result.accuracyScore,
      fluencyScore: result.fluencyScore,
      completenessScore: result.completenessScore,
      prosodyScore: result.prosodyScore,
      transcript: result.transcript,
      wordScores: result.wordScores,
      audioUrl: saved.url,
    },
  });

  // 5. Consume the entitlement (trial/ad credit; subscription tracked by count).
  await consumeSpeaking(req.user, access.source);

  // 6. Speaking counts as activity -> keep the streak alive.
  const streak = await touchStreak(req.user.id);

  res.status(201).json({
    attemptId: attempt.id,
    source: access.source,
    scores: {
      overall: result.overallScore,
      accuracy: result.accuracyScore,
      fluency: result.fluencyScore,
      completeness: result.completenessScore,
      prosody: result.prosodyScore,
    },
    transcript: result.transcript,
    wordScores: result.wordScores,
    feedback: result.feedback,
    streak,
  });
});

// GET /speaking/history
export const getSpeakingHistory = asyncHandler(async (req, res) => {
  const attempts = await prisma.speakingAttempt.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: {
      id: true,
      cardId: true,
      overallScore: true,
      accuracyScore: true,
      fluencyScore: true,
      createdAt: true,
      card: { select: { title: true } },
    },
  });
  res.json({ items: attempts });
});
