import { asyncHandler } from '../utils/asyncHandler.js';
import {
  getTodaySetForUser,
  submitVocabAnswer,
  getMyVocabStatus,
} from '../services/dailyVocab.service.js';

export const getTodayVocab = asyncHandler(async (req, res) => {
  const set = await getTodaySetForUser(req.user);
  if (!set) return res.status(503).json({ error: { message: "Today's vocab isn't ready yet." } });
  res.json(set);
});

export const submitVocab = asyncHandler(async (req, res) => {
  const { wordId, chosenIndex } = req.body || {};
  if (!wordId || !Number.isInteger(chosenIndex)) {
    return res.status(400).json({ error: { message: 'wordId and chosenIndex are required' } });
  }
  const result = await submitVocabAnswer(req.user, { wordId, chosenIndex });
  if (result.error) {
    const code = result.error === 'ALREADY_ANSWERED' ? 409 : 400;
    return res.status(code).json({ error: { code: result.error, message: result.error } });
  }
  res.json(result);
});

export const getVocabStatus = asyncHandler(async (req, res) => {
  res.json(await getMyVocabStatus(req.user));
});