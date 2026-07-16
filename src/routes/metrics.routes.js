import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { getMetrics } from '../controllers/metrics.controller.js';

const router = Router();

// Admin-only metrics feed for the /admin dashboard page.
router.get('/metrics', requireAuth, requireAdmin, getMetrics);

export default router;