import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { updateSettingsSchema } from '../validators/schemas.js';
import * as settings from '../controllers/settings.controller.js';

const router = Router();

// Admin only — the master ad switch lives here.
router.use(requireAuth, requireAdmin);
router.get('/', settings.getSettings);
router.patch('/', validate(updateSettingsSchema), settings.updateSettings);

export default router;