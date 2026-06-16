import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as vocab from '../controllers/vocab.controller.js';

const router = Router();
router.use(requireAuth);
router.get('/progress', vocab.getProgress);
router.get('/ladder/:n', vocab.getLadder);
router.post('/word/:id/learn', vocab.learnWord);

router.post('/ladder/:n/complete', vocab.completeLadder);
export default router;