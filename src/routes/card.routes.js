import { Router } from 'express';
import multer from 'multer';
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { speakingLimiter } from '../middleware/rateLimit.js';
import {
  feedQuerySchema,
  cardIdParam,
  createCardSchema,
  generateCardSchema,
  completeCardSchema,
} from '../validators/schemas.js';
import * as card from '../controllers/card.controller.js';
import * as speaking from '../controllers/speaking.controller.js';

const router = Router();

// In-memory upload, 8MB cap, audio only.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Only audio uploads are allowed'));
  },
});

// --- Public reading (works with or without login) ---
router.get('/feed', optionalAuth, validate(feedQuerySchema), card.getFeed);

// '/saved' MUST come before '/:id', or it gets captured as an id.
router.get('/saved', requireAuth, card.listSavedCards);

// Public single card (placed after /saved so it isn't shadowed)
router.get('/:id', optionalAuth, validate(cardIdParam), card.getCard);

// --- Account-only ---
router.post('/:id/complete', requireAuth, validate(completeCardSchema), card.completeCard);
router.post('/:id/save', requireAuth, validate(cardIdParam), card.saveCard);
router.delete('/:id/save', requireAuth, validate(cardIdParam), card.unsaveCard);

router.post(
  '/:id/speak',
  requireAuth,
  speakingLimiter,
  validate(cardIdParam),
  upload.single('audio'),
  speaking.submitSpeaking
);

// --- Admin ---
router.post('/', requireAuth, requireAdmin, validate(createCardSchema), card.createCard);
router.post('/generate', requireAuth, requireAdmin, validate(generateCardSchema), card.generateAndCreateCard);

export default router;