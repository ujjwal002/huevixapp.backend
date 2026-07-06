import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  tutorApplySchema,
  tutorUpdateSchema,
  tutorRejectSchema,
  tutorIdParam,
  tutorPayoutSchema,
} from '../validators/schemas.js';
import * as tutor from '../controllers/tutor.controller.js';

const router = Router();
router.use(requireAuth);

// --- Tutor self-serve ---
router.post('/apply', validate(tutorApplySchema), tutor.apply);
router.get('/me', tutor.me);
router.patch('/me', validate(tutorUpdateSchema), tutor.updateMe);

// --- Learner-facing ---
router.get('/online', tutor.listOnline);

// --- Admin ---
router.get('/admin', requireAdmin, tutor.adminList);
router.post('/admin/:id/approve', requireAdmin, validate(tutorIdParam), tutor.adminApprove);
router.post('/admin/:id/reject', requireAdmin, validate(tutorRejectSchema), tutor.adminReject);
router.post('/admin/:id/suspend', requireAdmin, validate(tutorIdParam), tutor.adminSuspend);
router.post('/admin/:id/payouts', requireAdmin, validate(tutorPayoutSchema), tutor.adminRecordPayout);

export default router;