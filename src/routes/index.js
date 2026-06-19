import { Router } from 'express';
import authRoutes from './auth.routes.js';
import userRoutes from './user.routes.js';
import cardRoutes from './card.routes.js';
import vocabRoutes from './vocab.routes.js';
import grammarRoutes from './grammar.routes.js';
import sponsoredRoutes from './sponsored.routes.js';

import promoRoutes from './promo.routes.js';

import settingsRoutes from './settings.routes.js';


import { speakingRouter, adsRouter, subRouter, notificationRouter } from './misc.routes.js';
import { getAppSettings } from '../services/settings.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_NATIVE_LANGUAGES,
  config,
} from '../config/env.js';

const router = Router();

router.get('/health', (_req, res) =>
  res.json({ status: 'ok', mock: config.mockExternal, time: new Date().toISOString() })
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

export default router;