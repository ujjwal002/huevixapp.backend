import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { checkEligibility, jobStatus, resolveFee } from '../services/eligibility.service.js';

// ---------------------------------------------------------------------------
// User profile (the 7 questions, asked once)
// ---------------------------------------------------------------------------

export const getMyProfile = asyncHandler(async (req, res) => {
  const profile = await prisma.eligibilityProfile.findUnique({
    where: { userId: req.user.id },
  });
  // null (never filled) is a valid state the client uses to show onboarding.
  res.json({ profile });
});

export const upsertMyProfile = asyncHandler(async (req, res) => {
  const data = { ...req.body };
  if (data.dob) data.dob = new Date(data.dob);
  const profile = await prisma.eligibilityProfile.upsert({
    where: { userId: req.user.id },
    create: { userId: req.user.id, ...data },
    update: data,
  });
  res.json({ profile });
});

// ---------------------------------------------------------------------------
// Public feed
// ---------------------------------------------------------------------------

// GET /gov-jobs?state=BR&status=OPEN&q=constable
// optionalAuth: guests get the raw list; logged-in users with a profile get a
// personal { verdict, fee } on every card — computed in-process by the pure
// engine, so it costs one profile lookup total, not one query per job.
export const listJobs = asyncHandler(async (req, res) => {
  const { state, status, q, limit, cursor } = req.query;

  const where = { verified: true };
  if (state) where.OR = [{ state }, { state: null }]; // state jobs + all-India
  if (q) where.title = { contains: q, mode: 'insensitive' };

  // Date-window prefilter so status filtering doesn't scan the whole table.
  // Exact status still derived per-row (handles null dates correctly).
  const today = new Date();
  if (status === 'OPEN') {
    where.AND = [
      { OR: [{ applyStartDate: null }, { applyStartDate: { lte: today } }] },
      { OR: [{ applyEndDate: null }, { applyEndDate: { gte: today } }] },
    ];
  } else if (status === 'UPCOMING') {
    where.applyStartDate = { gt: today };
  } else if (status === 'CLOSED') {
    where.applyEndDate = { lt: today };
  }

  const jobs = await prisma.govJob.findMany({
    where,
    orderBy: [{ applyEndDate: 'asc' }, { createdAt: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });

  const hasMore = jobs.length > limit;
  const page = hasMore ? jobs.slice(0, limit) : jobs;

  const profile = req.user
    ? await prisma.eligibilityProfile.findUnique({ where: { userId: req.user.id } })
    : null;

  const items = page.map((job) => {
    const base = {
      id: job.id,
      title: job.title,
      organization: job.organization,
      state: job.state,
      totalVacancies: job.totalVacancies,
      applyStartDate: job.applyStartDate,
      applyEndDate: job.applyEndDate,
      status: jobStatus(job),
      requiresCet: job.requiresCet,
    };
    if (profile) {
      const result = checkEligibility(profile, job);
      base.personal = { verdict: result.verdict, fee: result.fee.amount };
    } else {
      // Guests still see the general fee range so the card isn't empty.
      base.feeDefault = resolveFee(job.feeRules, {}).amount;
    }
    return base;
  });

  res.json({
    jobs: items,
    nextCursor: hasMore ? page[page.length - 1].id : null,
    profileComplete: !!profile,
  });
});

// GET /gov-jobs/:id — full detail; personalized block included when possible.
export const getJob = asyncHandler(async (req, res) => {
  const job = await prisma.govJob.findUnique({ where: { id: req.params.id } });
  if (!job || (!job.verified && req.user?.role !== 'ADMIN')) {
    throw ApiError.notFound('Job not found');
  }
  const profile = req.user
    ? await prisma.eligibilityProfile.findUnique({ where: { userId: req.user.id } })
    : null;
  res.json({
    job: { ...job, status: jobStatus(job) },
    personal: profile ? checkEligibility(profile, job) : null,
    profileComplete: !!profile,
  });
});

// GET /gov-jobs/:id/eligibility — the headline feature. Requires auth so the
// answer is always "for YOU", never generic.
export const checkJobEligibility = asyncHandler(async (req, res) => {
  const job = await prisma.govJob.findUnique({ where: { id: req.params.id } });
  if (!job || !job.verified) throw ApiError.notFound('Job not found');

  const profile = await prisma.eligibilityProfile.findUnique({
    where: { userId: req.user.id },
  });
  if (!profile) {
    throw ApiError.badRequest('Fill your eligibility profile first', 'PROFILE_REQUIRED');
  }
  res.json({
    jobId: job.id,
    title: job.title,
    ...checkEligibility(profile, job),
  });
});

// ---------------------------------------------------------------------------
// Admin: sources + job CRUD (crawler/LLM output lands here, verified=false)
// ---------------------------------------------------------------------------

export const listSources = asyncHandler(async (_req, res) => {
  const sources = await prisma.govJobSource.findMany({ orderBy: { shortName: 'asc' } });
  res.json({ sources });
});

async function resolveSourceId(sourceShortName) {
  if (!sourceShortName) return undefined;
  const src = await prisma.govJobSource.findUnique({ where: { shortName: sourceShortName } });
  if (!src) throw ApiError.badRequest(`Unknown source "${sourceShortName}"`, 'UNKNOWN_SOURCE');
  return src.id;
}

const DATE_FIELDS = ['applyStartDate', 'applyEndDate', 'examDate'];

function coerceDates(body) {
  const out = { ...body };
  for (const f of DATE_FIELDS) {
    if (out[f] !== undefined && out[f] !== null) out[f] = new Date(out[f]);
  }
  return out;
}

export const createJob = asyncHandler(async (req, res) => {
  const { sourceShortName, ...body } = req.body;
  const sourceId = await resolveSourceId(sourceShortName);
  const job = await prisma.govJob.create({
    data: { ...coerceDates(body), ...(sourceId ? { sourceId } : {}) },
  });
  res.status(201).json({ job });
});

export const updateJob = asyncHandler(async (req, res) => {
  const { sourceShortName, ...body } = req.body;
  const sourceId = await resolveSourceId(sourceShortName);
  const job = await prisma.govJob
    .update({
      where: { id: req.params.id },
      data: { ...coerceDates(body), ...(sourceId ? { sourceId } : {}) },
    })
    .catch(() => null);
  if (!job) throw ApiError.notFound('Job not found');
  res.json({ job });
});

export const deleteJob = asyncHandler(async (req, res) => {
  await prisma.govJob.delete({ where: { id: req.params.id } }).catch(() => {
    throw ApiError.notFound('Job not found');
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Admin: crawler review queue
// ---------------------------------------------------------------------------

// The daily review screen: crawler-extracted jobs awaiting `verified: true`
// (PATCH /admin/jobs/:id), plus recent extraction failures (scanned PDFs,
// broken links) so nothing silently disappears.
export const reviewQueue = asyncHandler(async (_req, res) => {
  const [pendingJobs, failedItems, queueDepth] = await Promise.all([
    prisma.govJob.findMany({
      where: { verified: false },
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { source: { select: { shortName: true, name: true } } },
    }),
    prisma.govCrawlItem.findMany({
      where: { status: 'FAILED' },
      orderBy: { firstSeenAt: 'desc' },
      take: 50,
    }),
    prisma.govCrawlItem.count({ where: { status: 'NEW' } }),
  ]);
  res.json({
    pendingJobs: pendingJobs.map((j) => ({ ...j, status: jobStatus(j) })),
    failedItems,
    queueDepth,
  });
});

// Mark a crawl item IGNORED (result pages, admit cards, duplicates) so it
// leaves the failure list and is never retried.
export const ignoreCrawlItem = asyncHandler(async (req, res) => {
  const item = await prisma.govCrawlItem
    .update({ where: { id: req.params.id }, data: { status: 'IGNORED' } })
    .catch(() => null);
  if (!item) throw ApiError.notFound('Crawl item not found');
  res.json({ item });
});