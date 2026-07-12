import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as vocab from '../controllers/dailyVocab.controller.js';

const router = Router();

router.use(requireAuth);
router.get('/today', vocab.getTodayVocab);
router.get('/status', vocab.getVocabStatus);
router.post('/answer', vocab.submitVocab);

export default router;