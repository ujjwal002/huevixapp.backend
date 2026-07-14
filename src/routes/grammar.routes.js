import { Router } from 'express';
import * as grammar from '../controllers/grammar.controller.js';
const router = Router();
router.get('/', grammar.listLessons);
router.get('/:id', grammar.getLesson);
export default router;
