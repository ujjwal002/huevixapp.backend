import { Router } from 'express';
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createPromoSchema,
  promoIdParam,
  rejectPromoSchema,
  promosMineQuerySchema,
  confirmPromoGoogleSchema,
} from '../validators/schemas.js';
import { metricsLimiter, promoCreateLimiter } from '../middleware/rateLimit.js';
import * as promo from '../controllers/promo.controller.js';

const router = Router();

// --- Purchase (Google Play only; the Razorpay create/confirm/pay routes were
// --- removed with the payments migration) ----------------------------------
router.post('/google', requireAuth, promoCreateLimiter, validate(createPromoSchema), promo.createPromoGoogle);
router.post('/:id/confirm-google', requireAuth, validate(confirmPromoGoogleSchema), promo.confirmPromoGoogle);

// --- Admin review -----------------------------------------------------------
router.get('/admin', requireAuth, requireAdmin, promo.listPromosForReview);
router.post('/admin/:id/approve', requireAuth, requireAdmin, validate(promoIdParam), promo.approvePromo);
router.post('/admin/:id/reject', requireAuth, requireAdmin, validate(rejectPromoSchema), promo.rejectPromo);

// --- Feed serving + tracking + dashboard ------------------------------------
router.get('/active', optionalAuth, promo.listActivePromos);
router.get('/mine', requireAuth, validate(promosMineQuerySchema), promo.listMyPromos);
router.post('/:id/impression', requireAuth, metricsLimiter, validate(promoIdParam), promo.recordImpression);
router.post('/:id/click', optionalAuth, metricsLimiter, validate(promoIdParam), promo.recordClick);

router.delete('/:id', requireAuth, validate(promoIdParam), promo.deletePromo);

export default router;