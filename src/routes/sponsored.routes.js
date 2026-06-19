import { Router } from 'express';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import {
  createSponsoredSchema,
  updateSponsoredSchema,
  sponsoredIdParam,
} from '../validators/schemas.js';
import {
  listSponsored, listAllSponsored, createSponsored, updateSponsored, deleteSponsored,
} from '../controllers/sponsored.controller.js';

const router = Router();

router.get('/', listSponsored); // public

router.get('/admin', requireAuth, requireAdmin, listAllSponsored);
router.post('/admin', requireAuth, requireAdmin, validate(createSponsoredSchema), createSponsored);
router.patch('/admin/:id', requireAuth, requireAdmin, validate(updateSponsoredSchema), updateSponsored);
router.delete('/admin/:id', requireAuth, requireAdmin, validate(sponsoredIdParam), deleteSponsored);

export default router;