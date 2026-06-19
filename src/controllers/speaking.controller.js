import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { assessPronunciation } from '../services/speech.service.js';
import { saveBuffer, resolveLocalPath, getPresignedDownloadUrl } from '../services/storage.service.js';
import {
  getSpeakingAccess,
  reserveCredit,
  refundCredit,
} from '../services/entitlement.service.js';
import { touchStreak } from '../services/streak.service.js';

// Build the authenticated URL the client uses to play a recording back. The
// recording is NOT served from the public /static mount (Fix #3) — it is PII.
function recordingUrl(attemptId) {
  return `${config.apiPrefix}/speaking/recordings/${attemptId}`;
}

// Fix: clamp the client-controlled mime subtype to a short safe extension so it
// can never influence the on-disk filename in unexpected ways.
function safeExt(mimetype) {
  const raw = (mimetype?.split('/')[1] || 'wav').replace('x-wav', 'wav').toLowerCase();
  const cleaned = raw.replace(/[^a-z0-9]/g, '');
  const allowed = new Set(['wav', 'webm', 'mp3', 'm4a', 'mp4', 'ogg', 'opus', 'aac', 'flac']);
  return allowed.has(cleaned) ? cleaned : 'bin';
}

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

  // 2. Fix #7: atomically reserve the consumable credit BEFORE touching paid
  //    external APIs. If we lost a race, re-check access and surface the gate.
  const reserved = await reserveCredit(req.user, access.source);
  if (!reserved) {
    const recheck = await getSpeakingAccess(req.user);
    throw ApiError.payment(
      recheck.message || 'Your free speaking attempts are used up. Subscribe to keep practising speaking.',
      recheck.reason || 'PAYWALL'
    );
  }

  let saved;
  let result;
  try {
    // 3. Store the recording (kept private; useful for review/debugging).
    saved = await saveBuffer(req.file.buffer, {
      folder: 'recordings',
      ext: safeExt(req.file.mimetype),
    });

    // 4. Run pronunciation assessment against the reference text.
    result = await assessPronunciation({
      audioBuffer: req.file.buffer,
      referenceText: card.body,
      targetLanguage: card.targetLanguage,
    });
  } catch (err) {
    // Fix #7: a failed assessment must not cost the user a credit.
    await refundCredit(req.user, access.source).catch(() => {});
    throw err;
  }

  // 5. Persist the attempt. We store the storage KEY (not a public URL) so the
  //    recording can only be fetched via the authenticated route (Fix #3).
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
      audioUrl: saved.key, // relative storage key, e.g. "recordings/<uuid>.webm"
    },
  });

  // 6. Speaking counts as activity -> keep the streak alive.
  const streak = await touchStreak(req.user.id);

  res.status(201).json({
    attemptId: attempt.id,
    source: access.source,
    recordingUrl: recordingUrl(attempt.id),
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
  res.json({
    items: attempts.map((a) => ({ ...a, recordingUrl: recordingUrl(a.id) })),
  });
});

// GET /speaking/recordings/:id  (Fix #3)
// Streams a recording ONLY to the user who owns the attempt.
//   - local: served from disk; the stored key is resolved under STORAGE_ROOT
//     and verified to stay inside it, so a crafted key cannot traverse out.
//   - s3: the bucket stays private; the owner is redirected to a short-lived
//     presigned URL (which also gives the browser range requests for seeking).
export const getRecording = asyncHandler(async (req, res) => {
  const attempt = await prisma.speakingAttempt.findUnique({
    where: { id: req.params.id },
    select: { userId: true, audioUrl: true },
  });
  if (!attempt || attempt.userId !== req.user.id) {
    throw ApiError.notFound('Recording not found');
  }
  if (!attempt.audioUrl) throw ApiError.notFound('Recording not available');

  if (config.storage.driver === 's3') {
    const url = await getPresignedDownloadUrl(attempt.audioUrl, { expiresIn: 300 });
    return res.redirect(302, url);
  }

  const resolved = resolveLocalPath(attempt.audioUrl);
  if (!resolved) throw ApiError.notFound('Recording not found');
  res.sendFile(resolved);
});