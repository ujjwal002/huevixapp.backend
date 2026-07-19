import { Router } from 'express';
import { requireAuth, requireAdmin, optionalAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as govJobs from '../controllers/govJobs.controller.js';
import {
  upsertProfileSchema,
  listJobsSchema,
  jobIdParam,
  createJobSchema,
  updateJobSchema,
} from '../validators/govJobs.schemas.js';

const router = Router();

// --- profile (authed) — MUST be registered before '/:id' so the literal path
// "profile" isn't captured by the uuid param route.
router.get('/profile', requireAuth, govJobs.getMyProfile);
router.put('/profile', requireAuth, validate(upsertProfileSchema), govJobs.upsertMyProfile);

// --- public feed (guests see the list; logged-in users get personal verdicts)
router.get('/', optionalAuth, validate(listJobsSchema), govJobs.listJobs);
router.get('/:id', optionalAuth, validate(jobIdParam), govJobs.getJob);

// --- the headline feature: "am I eligible, what's MY fee, MY age limit?"
router.get('/:id/eligibility', requireAuth, validate(jobIdParam), govJobs.checkJobEligibility);

// --- admin: sources + job CRUD (crawler output lands here as verified=false)
router.get('/admin/sources', requireAuth, requireAdmin, govJobs.listSources);
router.get('/admin/review', requireAuth, requireAdmin, govJobs.reviewQueue);
router.patch('/admin/items/:id/ignore', requireAuth, requireAdmin, govJobs.ignoreCrawlItem);
router.post('/admin/jobs', requireAuth, requireAdmin, validate(createJobSchema), govJobs.createJob);
router.patch(
  '/admin/jobs/:id',
  requireAuth,
  requireAdmin,
  validate(updateJobSchema),
  govJobs.updateJob
);
router.delete(
  '/admin/jobs/:id',
  requireAuth,
  requireAdmin,
  validate(jobIdParam),
  govJobs.deleteJob
);

export default router;