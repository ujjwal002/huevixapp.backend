import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  payoutRequestSchema,
  payoutReferenceSchema,
  rejectPayoutSchema,
} from '../validators/schemas.js';
import * as referral from '../controllers/referral.controller.js';

const router = Router();

// --- User ---
router.get('/me', requireAuth, referral.getMyReferral);
router.get('/payouts', requireAuth, referral.myPayouts);
router.post('/payout', requireAuth, validate(payoutRequestSchema), referral.requestPayout);

// --- Admin review + manual UPI payout ---
router.get('/admin/payouts', requireAuth, requireAdmin, referral.adminListPayouts);
router.post(
  '/admin/payouts/:id/pay',
  requireAuth,
  requireAdmin,
  validate(payoutReferenceSchema),
  referral.adminPayPayout
);
router.post(
  '/admin/payouts/:id/reject',
  requireAuth,
  requireAdmin,
  validate(rejectPayoutSchema),
  referral.adminRejectPayout
);

export default router;