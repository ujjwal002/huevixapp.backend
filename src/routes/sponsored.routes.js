import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import {
  listSponsored, listAllSponsored, createSponsored, updateSponsored, deleteSponsored,
} from '../controllers/sponsored.controller.js';

const router = Router();

router.get('/', listSponsored); // public

router.get('/admin', requireAuth, requireAdmin, listAllSponsored);
router.post('/admin', requireAuth, requireAdmin, createSponsored);
router.patch('/admin/:id', requireAuth, requireAdmin, updateSponsored);
router.delete('/admin/:id', requireAuth, requireAdmin, deleteSponsored);

export default router;