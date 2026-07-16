import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { uploadAudio } from '../middleware/upload.js';
import { voiceStartSchema, voiceEndSchema, voiceTurnSchema } from '../validators/schemas.js';
import * as voice from '../controllers/voice.controller.js';

const router = Router();

router.get('/me', requireAuth, voice.status);
router.post('/session/start', requireAuth, validate(voiceStartSchema), voice.startSession);
router.post('/session/end', requireAuth, validate(voiceEndSchema), voice.endSession);
router.get('/session/:id/scorecard', requireAuth, voice.scorecard);
// uploadAudio (multer) runs before validate so multipart text fields
// (sessionId, userMs) are parsed into req.body.
router.post('/turn', requireAuth, uploadAudio('audio'), validate(voiceTurnSchema), voice.turn);

export default router;