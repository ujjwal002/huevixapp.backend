import { Router } from 'express';
import multer from 'multer';
import { requireAuth } from '../middleware/auth.js';
import * as tutor from '../controllers/vocabTutor.controller.js';

// In-memory upload for the learner's spoken answer: audio only, 8MB cap.
const audioUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('audio/')) cb(null, true);
    else cb(new Error('Only audio uploads are allowed'));
  },
});

const router = Router();
router.use(requireAuth);

router.get('/status', tutor.status);
router.post('/start', tutor.startSession);
// A quiz turn carries the spoken answer; a teaching turn can be sent with no file.
router.post('/turn', audioUpload.single('audio'), tutor.turn);
router.post('/end', tutor.endSession);

export default router;
