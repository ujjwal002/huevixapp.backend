import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { updateMeSchema, deleteMeSchema } from '../validators/schemas.js';
import * as user from '../controllers/user.controller.js';

const router = Router();

router.use(requireAuth);
router.get('/me', user.getMe);
router.patch('/me', validate(updateMeSchema), user.updateMe);
router.delete('/me', validate(deleteMeSchema), user.deleteMe);
router.get('/me/stats', user.getStats);

router.get('/leaderboard', user.getLeaderboard);

export default router;