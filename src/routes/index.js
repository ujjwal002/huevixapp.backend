import { Router } from 'express';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import cardRoutes from './card.routes.js';
import vocabRoutes from './vocab.routes.js';
import grammarRoutes from './grammar.routes.js';
import sponsoredRoutes from './sponsored.routes.js';

import promoRoutes from './promo.routes.js';

import settingsRoutes from './settings.routes.js';

import vocabTutorRoutes from './vocabTutor.routes.js';

import callsRoutes from './calls.routes.js';

import * as gpurchase from '../controllers/googlePurchase.controller.js';
import { requireAuth } from '../middleware/auth.js';

import { prisma } from '../db/prisma.js';

import { admobSsv } from '../controllers/admobSsv.controller.js';





import { speakingRouter, adsRouter, subRouter, notificationRouter } from './misc.routes.js';
import { getAppSettings } from '../services/settings.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';

import quizRoutes from './quiz.routes.js';
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_NATIVE_LANGUAGES,
  config,
} from '../config/env.js';

const router = Router();

// Liveness + readiness. Pings the database so an orchestrator probe won't route
// traffic to an instance that can't reach Postgres (returns 503 when it can't).
router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    let db = 'ok';
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    const status = db === 'ok' ? 'ok' : 'degraded';
    res
      .status(db === 'ok' ? 200 : 503)
      .json({ status, db, mock: config.mockExternal, time: new Date().toISOString() });
  })
);

// Public metadata: which languages + pricing the client should show, plus the
// current ad settings (master switch + cadence hint) so the app knows whether
// and how densely to weave ads into the feed.
router.get(
  '/meta',
  asyncHandler(async (_req, res) => {
    const settings = await getAppSettings();
    res.json({
      targetLanguages: SUPPORTED_LANGUAGES,
      nativeLanguages: SUPPORTED_NATIVE_LANGUAGES,
      pricing: config.pricing,
      entitlement: config.entitlement,
      ads: { enabled: settings.adsEnabled, everyNCards: settings.adEveryNCards },
    });
  })
);

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/cards', cardRoutes);
router.use('/speaking', speakingRouter);
router.use('/ads', adsRouter);
router.use('/subscription', subRouter);
router.use('/notifications', notificationRouter);

router.use('/vocab', vocabRoutes);
router.use('/grammar', grammarRoutes);

router.use('/sponsored', sponsoredRoutes);

router.use('/promos', promoRoutes);

router.use('/admin/settings', settingsRoutes);

router.use('/vocab-tutor', vocabTutorRoutes);

router.use('/calls', callsRoutes);

router.use('/quiz', quizRoutes);

router.get('/ads/admob-ssv', admobSsv);


// Google Play: one-time credit packs (authed)
const purchasesRouter = Router();
purchasesRouter.use(requireAuth);
purchasesRouter.post('/google/verify', gpurchase.verifyGoogleProduct);
router.use('/purchases', purchasesRouter);

// Google Play: RTDN push endpoint (no auth — protected by the secret in the URL)
router.post('/google/rtdn/:secret', gpurchase.googleRtdn);

export default router;