import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import * as svc from '../services/quiz.service.js';

// --- player ------------------------------------------------------------------

export const getToday = asyncHandler(async (req, res) => {
  const data = await svc.getTodayForUser(req.user);
  if (!data) throw ApiError.notFound('No quiz available today');
  res.json(data);
});

export const answer = asyncHandler(async (req, res) => {
  const r = await svc.submitAnswer(req.user, req.body);
  if (r.error) {
    const map = {
      NOT_FOUND: ApiError.notFound('Question not found'),
      VOIDED: ApiError.badRequest('This question was removed', 'QUESTION_VOIDED'),
      NOT_TODAY: ApiError.badRequest("You can only answer today's quiz", 'NOT_TODAY'),
      BAD_CHOICE: ApiError.badRequest('Invalid choice', 'BAD_CHOICE'),
      ALREADY_ANSWERED: ApiError.conflict('You already answered this question', 'ALREADY_ANSWERED'),
    };
    throw map[r.error] || ApiError.badRequest('Could not submit answer');
  }
  res.json(r);
});

export const leaderboard = asyncHandler(async (req, res) => {
  res.json(await svc.getLeaderboard(req.user, { limit: req.query.limit }));
});

export const me = asyncHandler(async (req, res) => {
  res.json(await svc.getMyQuizStatus(req.user));
});

// --- winner / opportunity ----------------------------------------------------

export const currentWinner = asyncHandler(async (req, res) => {
  const winner = await svc.getClaimableWinner(req.user);
  res.json({ winner: winner || null });
});

export const acceptOffer = asyncHandler(async (req, res) => {
  const r = await svc.acceptOffer(req.user, req.body);
  if (r.error === 'NO_OFFER') {
    throw ApiError.badRequest('You have no opportunity to accept', 'NO_OFFER');
  }
  res.status(201).json(r);
});

// --- admin -------------------------------------------------------------------

export const adminGenerate = asyncHandler(async (req, res) => {
  const quiz = await svc.getOrCreateTodayQuiz(req.body.targetLanguage || 'en');
  res.status(201).json({
    quizId: quiz.id,
    date: quiz.date,
    targetLanguage: quiz.targetLanguage,
    questionCount: quiz.questions?.length ?? 0,
  });
});

export const adminSelectWinner = asyncHandler(async (req, res) => {
  const r = await svc.selectWinner(req.body.period, { note: req.body.note });
  if (r.error === 'NO_PARTICIPANTS')
    throw ApiError.badRequest('No participants for that month', 'NO_PARTICIPANTS');
  if (r.error === 'ALREADY_SELECTED')
    throw ApiError.conflict('Winner already selected for that month', 'ALREADY_SELECTED');
  res.status(201).json(r);
});

export const adminApproveWinner = asyncHandler(async (req, res) => {
  const r = await svc.approveWinner(req.params.id);
  if (r.error === 'NOT_FOUND') throw ApiError.notFound('Winner not found');
  if (r.error === 'NOT_PENDING_REVIEW')
    throw ApiError.badRequest('Winner is not awaiting review', 'NOT_PENDING_REVIEW');
  res.json(r);
});

export const adminListWinners = asyncHandler(async (_req, res) => {
  res.json({ items: await svc.listWinners() });
});

export const adminUpdateWinner = asyncHandler(async (req, res) => {
  const r = await svc.updateWinnerStatus(req.params.id, req.body.status);
  if (r.error === 'BAD_STATUS') throw ApiError.badRequest('Invalid status', 'BAD_STATUS');
  res.json(r);
});

export const adminVoidQuestion = asyncHandler(async (req, res) => {
  const r = await svc.voidQuestion(req.params.id);
  if (r.error === 'NOT_FOUND') throw ApiError.notFound('Question not found');
  res.json(r);
});
