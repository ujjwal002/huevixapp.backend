import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import * as calls from '../controllers/calls.controller.js';

const router = Router();

router.use(requireAuth);
router.get('/turn-credentials', calls.getTurnCredentials);
router.get('/history', calls.getCallHistory);

router.post('/report', calls.reportUser);
router.post('/block', calls.blockUser);
router.delete('/block/:userId', calls.unblockUser);
router.get('/blocks', calls.listBlocks);

router.get('/balance', calls.getCallBalance);
router.post('/recharge', calls.rechargeCall);

router.post('/grant-ad-video', calls.grantAdVideo);

export default router;
