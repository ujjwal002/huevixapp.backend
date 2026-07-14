import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { metricsLimiter } from '../middleware/rateLimit.js';
import * as quiz from '../controllers/quiz.controller.js';
import {
  submitAnswerSchema,
  leaderboardQuerySchema,
  winnerAcceptSchema,
  adminGenerateSchema,
  adminSelectWinnerSchema,
  adminWinnerStatusSchema,
  idParam,
} from '../validators/quiz.schemas.js';

const router = Router();

// Everything here requires a logged-in user.
router.use(requireAuth);

// --- player ---
router.get('/today', quiz.getToday);
router.post('/answer', metricsLimiter, validate(submitAnswerSchema), quiz.answer);
router.get('/leaderboard', validate(leaderboardQuerySchema), quiz.leaderboard);
router.get('/me', quiz.me);

// --- winner / opportunity (the top scorer accepts the interview offer) ---
router.get('/winner/current', quiz.currentWinner);
router.post('/winner/accept', validate(winnerAcceptSchema), quiz.acceptOffer);

// --- admin ---
router.post('/admin/generate', requireAdmin, validate(adminGenerateSchema), quiz.adminGenerate);
router.post(
  '/admin/select-winner',
  requireAdmin,
  validate(adminSelectWinnerSchema),
  quiz.adminSelectWinner
);
router.get('/admin/winners', requireAdmin, quiz.adminListWinners);
router.post('/admin/winners/:id/approve', requireAdmin, validate(idParam), quiz.adminApproveWinner);
router.patch(
  '/admin/winners/:id',
  requireAdmin,
  validate({ ...idParam, ...adminWinnerStatusSchema }),
  quiz.adminUpdateWinner
);
router.post('/admin/questions/:id/void', requireAdmin, validate(idParam), quiz.adminVoidQuestion);

export default router;
