import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { updateMeSchema } from '../validators/schemas.js';
import * as user from '../controllers/user.controller.js';

const router = Router();

router.use(requireAuth);
router.get('/me', user.getMe);
router.patch('/me', validate(updateMeSchema), user.updateMe);
router.get('/me/stats', user.getStats);

export default router;
