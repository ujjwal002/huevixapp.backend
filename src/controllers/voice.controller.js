import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import * as voice from '../services/voice.service.js';

// GET /voice/me — coin balance, free seconds left today, pricing, mode list.
export const status = asyncHandler(async (req, res) => {
  res.json(await voice.voiceStatus(req.user.id));
});

// POST /voice/session/start — { mode? } opens a session, returns greeting + audio.
export const startSession = asyncHandler(async (req, res) => {
  res.status(201).json(await voice.startSession(req.user.id, req.body?.mode));
});

// POST /voice/session/end — closes the session and returns the shareable score card.
export const endSession = asyncHandler(async (req, res) => {
  res.json(await voice.endSession(req.user.id, req.body.sessionId));
});

// GET /voice/session/:id/scorecard — (re)fetch the score card for a session.
export const scorecard = asyncHandler(async (req, res) => {
  const card = await voice.scoreSession(req.user.id, req.params.id);
  if (!card) throw ApiError.notFound('No score card for this session yet.');
  res.json(card);
});

// POST /voice/turn — multipart: sessionId, userMs, audio. STT->brain->TTS, bills
// coins, returns transcript, reply, correction, and reply audio URL.
export const turn = asyncHandler(async (req, res) => {
  if (!req.file) throw ApiError.badRequest('Audio is required (field "audio").', 'NO_AUDIO');
  const result = await voice.processTurn(req.user.id, req.body.sessionId, req.file.buffer, {
    filename: req.file.originalname || 'turn.m4a',
    mimetype: req.file.mimetype || 'audio/m4a',
    userMs: Number(req.body.userMs) || 0,
  });
  if (result.error === 'NO_SESSION') throw ApiError.notFound('Voice session not found or already ended.');
  if (result.error === 'NEEDS_COINS') {
    throw ApiError.payment("You're out of free minutes and coins — top up to keep practicing.", 'NEEDS_COINS');
  }
  res.json(result);
});