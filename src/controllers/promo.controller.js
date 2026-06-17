import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { config } from '../config/env.js';
import { createPromoOrder, verifyPaymentSignature, refundPayment } from '../services/payment.service.js';
import { notifyPromoLive } from '../services/notification.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_DAYS = 30;

// POST /promos — create a draft promo + a Razorpay order for ₹299 × days.
export const createPromo = asyncHandler(async (req, res) => {
  const { startupName, title, body, ctaUrl, ctaText, imageUrl, days } = req.body;
  const nDays = Math.min(Math.max(days || 1, 1), MAX_DAYS);
  const amountPaise = config.pricing.promoPerDayInr * nDays * 100;

  const promo = await prisma.startupPromo.create({
    data: {
      ownerId: req.user.id,
      startupName, title, body,
      ctaUrl, ctaText: ctaText || 'Visit',
      imageUrl: imageUrl || null,
      days: nDays, amountPaise, status: 'PENDING_PAYMENT',
    },
  });

  const order = await createPromoOrder({ amountPaise, userId: req.user.id, promoId: promo.id });
  await prisma.startupPromo.update({ where: { id: promo.id }, data: { razorpayOrderId: order.orderId } });

  res.status(201).json({
    promoId: promo.id, orderId: order.orderId,
    amount: order.amount, currency: order.currency, keyId: order.keyId,
    days: nDays, amountInr: config.pricing.promoPerDayInr * nDays, mock: !!order._mock,
  });
});

// POST /promos/:id/confirm — verify the checkout signature, move to review.
export const confirmPromoPayment = asyncHandler(async (req, res) => {
  const { paymentId, signature } = req.body;
  const promo = await prisma.startupPromo.findUnique({ where: { id: req.params.id } });
  if (!promo || promo.ownerId !== req.user.id) throw ApiError.notFound('Promo not found');
  if (promo.status !== 'PENDING_PAYMENT') return res.json({ id: promo.id, status: promo.status });

  const ok = verifyPaymentSignature({ orderId: promo.razorpayOrderId, paymentId, signature });
  if (!ok) throw ApiError.badRequest('Payment verification failed', 'PAYMENT_VERIFICATION_FAILED');

  const updated = await prisma.startupPromo.update({
    where: { id: promo.id },
    data: { razorpayPaymentId: paymentId, status: 'PENDING_REVIEW' },
  });
  res.json({ id: updated.id, status: updated.status });
});

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
  if (promo.status !== 'PENDING_REVIEW') throw ApiError.badRequest('Only a pending promo can be rejected');

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
    select: { id: true, startupName: true, title: true, body: true, ctaText: true, ctaUrl: true, imageUrl: true },
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
export const listMyPromos = asyncHandler(async (req, res) => {
  const promos = await prisma.startupPromo.findMany({
    where: { ownerId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: { _count: { select: { impressions: true } } },
  });
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
  });
});

// POST /promos/:id/pay — resume payment for an unpaid promo (e.g. the user
// backed out of checkout). Reuses the original Razorpay order if still stored,
// so we don't leave orphan orders behind.
export const resumePayment = asyncHandler(async (req, res) => {
  const promo = await prisma.startupPromo.findUnique({ where: { id: req.params.id } });
  if (!promo || promo.ownerId !== req.user.id) throw ApiError.notFound('Promo not found');
  if (promo.status !== 'PENDING_PAYMENT') {
    return res.json({ promoId: promo.id, status: promo.status, alreadyPaid: true });
  }

  let orderId = promo.razorpayOrderId;
  if (!orderId) {
    const order = await createPromoOrder({ amountPaise: promo.amountPaise, userId: req.user.id, promoId: promo.id });
    orderId = order.orderId;
    await prisma.startupPromo.update({ where: { id: promo.id }, data: { razorpayOrderId: orderId } });
  }

  const mock = config.mockExternal || !config.razorpay.keyId;
  res.json({
    promoId: promo.id,
    orderId,
    amount: promo.amountPaise,
    currency: 'INR',
    keyId: mock ? 'rzp_test_mock' : config.razorpay.keyId,
    days: promo.days,
    amountInr: Math.round(promo.amountPaise / 100),
    mock,
  });
});

// DELETE /promos/:id — let an advertiser discard their own promo when it's
// unpaid, rejected, or finished. Live and in-review promos can't be deleted.
export const deletePromo = asyncHandler(async (req, res) => {
  const promo = await prisma.startupPromo.findUnique({ where: { id: req.params.id } });
  if (!promo || promo.ownerId !== req.user.id) throw ApiError.notFound('Promo not found');

  const ended = promo.status === 'ACTIVE' && !!promo.expiresAt && promo.expiresAt.getTime() <= Date.now();
  const removable = promo.status === 'PENDING_PAYMENT' || promo.status === 'REJECTED' || promo.status === 'EXPIRED' || ended;
  if (!removable) throw ApiError.badRequest("Can't remove a promotion while it's pending review or live");

  await prisma.startupPromo.delete({ where: { id: promo.id } });
  res.json({ ok: true });
});