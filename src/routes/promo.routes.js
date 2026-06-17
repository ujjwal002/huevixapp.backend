import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { createPromoSchema, confirmPromoSchema, promoIdParam, rejectPromoSchema } from '../validators/schemas.js';
import * as promo from '../controllers/promo.controller.js';

import {  optionalAuth } from '../middleware/auth.js';


const router = Router();

router.post('/', requireAuth, validate(createPromoSchema), promo.createPromo);
router.post('/:id/confirm', requireAuth, validate(confirmPromoSchema), promo.confirmPromoPayment);

router.get('/admin', requireAuth, requireAdmin, promo.listPromosForReview);
router.post('/admin/:id/approve', requireAuth, requireAdmin, validate(promoIdParam), promo.approvePromo);
router.post('/admin/:id/reject', requireAuth, requireAdmin, validate(rejectPromoSchema), promo.rejectPromo);

router.post('/:id/confirm', requireAuth, validate(confirmPromoSchema), promo.confirmPromoPayment);

// --- Feed serving + tracking + dashboard ---
router.get('/active', optionalAuth, promo.listActivePromos);
router.get('/mine', requireAuth, promo.listMyPromos);
router.post('/:id/impression', requireAuth, validate(promoIdParam), promo.recordImpression);
router.post('/:id/click', optionalAuth, validate(promoIdParam), promo.recordClick);

router.post('/:id/pay', requireAuth, validate(promoIdParam), promo.resumePayment);
router.delete('/:id', requireAuth, validate(promoIdParam), promo.deletePromo);

export default router;