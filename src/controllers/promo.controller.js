import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { config } from '../config/env.js';
import { refundPayment } from '../services/payment.service.js';
import { notifyPromoLive } from '../services/notification.service.js';

import * as gp from '../services/googlePlay.service.js';
import { saveBuffer } from '../services/storage.service.js';
import { imageExtFromMime, SUPPORTED_IMAGE_LABEL } from '../utils/image.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 30;

// Store an uploaded promo image (multer memory file) through the storage layer
// and return its public URL. Writes to local disk or S3 per STORAGE_DRIVER.
async function storeUploadedImage(file) {
  const ext = imageExtFromMime(file.mimetype);
  if (!ext) throw ApiError.badRequest(`Unsupported image type (use ${SUPPORTED_IMAGE_LABEL})`, 'BAD_IMAGE');
  const { url } = await saveBuffer(file.buffer, { folder: 'images', ext });
  return url;
}

// --------------------------- Admin review ---------------------------------
export const listPromosForReview = asyncHandler(async (_req, res) => {
  const items = await prisma.startupPromo.findMany({
    where: { status: { in: ['PENDING_REVIEW', 'ACTIVE'] } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
    include: { owner: { select: { email: true, name: true } } },
  });
  res.json({ items });
});

// POST /promos/admin/:id/approve — go live now; clock starts here; notify users.
export const approvePromo = asyncHandler(async (req, res) => {
  const promo = await prisma.startupPromo.findUnique({ where: { id: req.params.id } });
  if (!promo) throw ApiError.notFound('Promo not found');
  if (promo.status !== 'PENDING_REVIEW') throw ApiError.badRequest('Promo is not awaiting review');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + promo.days * DAY_MS);
  const updated = await prisma.startupPromo.update({
    where: { id: promo.id },
    data: { status: 'ACTIVE', liveAt: now, expiresAt },
  });
  await notifyPromoLive(updated);
  res.json(updated);
});

// POST /promos/admin/:id/reject — refund the upfront payment, mark rejected.
export const rejectPromo = asyncHandler(async (req, res) => {
  const promo = await prisma.startupPromo.findUnique({ where: { id: req.params.id } });
  if (!promo) throw ApiError.notFound('Promo not found');
  if (promo.status !== 'PENDING_REVIEW')
    throw ApiError.badRequest('Only a pending promo can be rejected');

  let refundId = null;
  if (promo.razorpayPaymentId) {
    const refund = await refundPayment(promo.razorpayPaymentId, promo.amountPaise);
    refundId = refund.refundId;
  }
  const updated = await prisma.startupPromo.update({
    where: { id: promo.id },
    data: { status: 'REJECTED', refundId, rejectionReason: req.body?.reason || null },
  });
  res.json(updated);
});

// ---------------------- Feed serving + tracking --------------------------

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// GET /promos/active — currently-live paid promos for the feed, shuffled so
// impressions spread evenly across advertisers. PRIORITY over house ads.
export const listActivePromos = asyncHandler(async (_req, res) => {
  const items = await prisma.startupPromo.findMany({
    where: { status: 'ACTIVE', expiresAt: { gt: new Date() } },
    select: {
      id: true,
      startupName: true,
      title: true,
      body: true,
      ctaText: true,
      ctaUrl: true,
      imageUrl: true,
    },
    take: 25,
  });
  res.json({ items: shuffle(items) });
});

// POST /promos/:id/impression — record a UNIQUE view (one row per user).
export const recordImpression = asyncHandler(async (req, res) => {
  try {
    await prisma.promoImpression.upsert({
      where: { promoId_userId: { promoId: req.params.id, userId: req.user.id } },
      create: { promoId: req.params.id, userId: req.user.id },
      update: {},
    });
  } catch {
    // best-effort — never fail the feed over a metric
  }
  res.json({ ok: true });
});

// POST /promos/:id/click — count a tap-through (total taps; guests included).
export const recordClick = asyncHandler(async (req, res) => {
  try {
    await prisma.startupPromo.update({
      where: { id: req.params.id },
      data: { clicks: { increment: 1 } },
    });
  } catch {
    // ignore unknown id
  }
  res.json({ ok: true });
});

// GET /promos/mine — the advertiser's own promos + performance numbers.
// GET /promos/mine — the advertiser's own promos + performance numbers (paginated).
export const listMyPromos = asyncHandler(async (req, res) => {
  const limit = req.query.limit ?? 20;
  const cursor = req.query.cursor;
  const promos = await prisma.startupPromo.findMany({
    where: { ownerId: req.user.id },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    include: { _count: { select: { impressions: true } } },
  });

  let nextCursor = null;
  if (promos.length > limit) {
    const next = promos.pop();
    nextCursor = next.id;
  }

  const now = Date.now();
  res.json({
    items: promos.map((p) => ({
      id: p.id,
      startupName: p.startupName,
      title: p.title,
      status: p.status,
      live: p.status === 'ACTIVE' && !!p.expiresAt && p.expiresAt.getTime() > now,
      days: p.days,
      amountInr: Math.round(p.amountPaise / 100),
      liveAt: p.liveAt,
      expiresAt: p.expiresAt,
      impressions: p._count.impressions, // unique viewers
      clicks: p.clicks,
      imageUrl: p.imageUrl,
      ctaUrl: p.ctaUrl,
      rejectionReason: p.rejectionReason,
      createdAt: p.createdAt,
    })),
    nextCursor,
  });
});

// DELETE /promos/:id — let an advertiser discard their own promo when it's
// unpaid, rejected, or finished. Live and in-review promos can't be deleted.
export const deletePromo = asyncHandler(async (req, res) => {
  const promo = await prisma.startupPromo.findUnique({ where: { id: req.params.id } });
  if (!promo || promo.ownerId !== req.user.id) throw ApiError.notFound('Promo not found');

  const ended =
    promo.status === 'ACTIVE' && !!promo.expiresAt && promo.expiresAt.getTime() <= Date.now();
  const removable =
    promo.status === 'PENDING_PAYMENT' ||
    promo.status === 'REJECTED' ||
    promo.status === 'EXPIRED' ||
    ended;
  if (!removable)
    throw ApiError.badRequest("Can't remove a promotion while it's pending review or live");

  await prisma.startupPromo.delete({ where: { id: promo.id } });
  res.json({ ok: true });
});

const PROMO_DAYS = {
  promote_1day: 1,
  promote_3day: 3,
  promote_7day: 7,
  promote_14day: 14,
  promote_30day: 30,
};

// POST /promos/google — create a draft promo for Google Play (no Razorpay order).
export const createPromoGoogle = asyncHandler(async (req, res) => {
  const { startupName, title, body, ctaUrl, ctaText, imageUrl, days } = req.body;
  const nDays = Math.min(Math.max(days || 1, 1), MAX_DAYS);
  const productId = `promote_${nDays}day`;
  if (!(productId in PROMO_DAYS)) throw ApiError.badRequest('Unsupported duration', 'BAD_DAYS');

  const amountPaise = config.pricing.promoPerDayInr * nDays * 100;
  // An uploaded file is stored to S3/local and takes precedence over any
  // imageUrl string, so existing JSON clients keep working unchanged.
  const storedImageUrl = req.file ? await storeUploadedImage(req.file) : imageUrl || null;
  const promo = await prisma.startupPromo.create({
    data: {
      ownerId: req.user.id,
      startupName,
      title,
      body,
      ctaUrl,
      ctaText: ctaText || 'Visit',
      imageUrl: storedImageUrl,
      days: nDays,
      amountPaise,
      status: 'PENDING_PAYMENT',
    },
  });

  res.status(201).json({
    promoId: promo.id,
    productId,
    days: nDays,
    amountInr: config.pricing.promoPerDayInr * nDays,
  });
});

// POST /promos/:id/confirm-google — verify the Google Play purchase, send to review.
export const confirmPromoGoogle = asyncHandler(async (req, res) => {
  const { productId, purchaseToken } = req.body;
  const promo = await prisma.startupPromo.findUnique({ where: { id: req.params.id } });
  if (!promo || promo.ownerId !== req.user.id) throw ApiError.notFound('Promo not found');
  if (promo.status !== 'PENDING_PAYMENT') return res.json({ id: promo.id, status: promo.status });

  const days = PROMO_DAYS[productId];
  if (!days) throw ApiError.badRequest('Unknown promote product', 'UNKNOWN_PRODUCT');
  if (days !== promo.days)
    throw ApiError.badRequest('Product does not match promo duration', 'DURATION_MISMATCH');

  const product = await gp.getProduct(productId, purchaseToken);
  if (product.purchaseState !== gp.PRODUCT_PURCHASED) {
    throw ApiError.badRequest('Purchase not completed', 'NOT_PURCHASED');
  }

  // A purchaseToken can fund exactly one promo (idempotent).
  try {
    await prisma.$transaction(async (tx) => {
      await tx.processedPurchase.create({
        data: { purchaseToken, productId, userId: req.user.id, orderId: product.orderId || null },
      });
      await tx.startupPromo.update({ where: { id: promo.id }, data: { status: 'PENDING_REVIEW' } });
    });
  } catch (e) {
    if (e?.code === 'P2002') {
      const fresh = await prisma.startupPromo.findUnique({ where: { id: promo.id } });
      return res.json({ id: promo.id, status: fresh?.status || 'PENDING_REVIEW', duplicate: true });
    }
    throw e;
  }

  await gp.consumeProduct(productId, purchaseToken); // consumable → can promote again later
  res.json({ id: promo.id, status: 'PENDING_REVIEW' });
});
