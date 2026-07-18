import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// =============================================================================
// Subscription controller — Google Play era.
//
// Payments moved from Razorpay to Google Play Billing. The Razorpay endpoints
// (checkout / verify / autopay / webhook) have been REMOVED: leaving them
// mounted while the server runs without Razorpay keys made
// /subscription/verify a free-premium endpoint (mock order + fail-open
// signature check). Purchases now flow exclusively through:
//
//   POST /subscription/google/verify   (googlePurchase.controller.js)
//   POST /purchases/google/verify      (one-time credit packs)
//   POST /google/rtdn/:secret          (renewals / cancellations / refunds)
// =============================================================================

// GET /subscription
export const getSubscription = asyncHandler(async (req, res) => {
  const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });
  res.json({ subscription: sub });
});

// POST /subscription/cancel
//
// Google Play subscriptions are cancelled IN THE PLAY STORE, not by us. If we
// flipped the local row to CANCELED here, Google would keep charging the user
// while the app told them they'd cancelled — the worst possible desync. So we
// return a manage URL and change nothing locally; the RTDN
// (SUBSCRIPTION_CANCELED / EXPIRED) is the source of truth and updates the row
// when Google confirms it.
//
// NOTE: the current app never calls this — Profile deep-links straight to the
// Play subscription center. Kept as a well-behaved endpoint for future
// clients (web dashboard, support tooling).
//
// (No legacy Razorpay branch: v1.0.0 never shipped, so razorpay rows cannot
// exist — and calling the removed Razorpay service would only ever throw.)
export const cancelSubscription = asyncHandler(async (req, res) => {
  const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });
  if (!sub) return res.json({ success: true, subscription: null });

  // Prefer the productId stored at verify time (exact SKU Google billed);
  // fall back to deriving from the plan for rows created before it existed.
  const productId =
    sub.productId ??
    (sub.plan === 'YEARLY' ? config.googlePlay.subYearlyId : config.googlePlay.subMonthlyId);

  const manageUrl =
    `https://play.google.com/store/account/subscriptions` +
    `?sku=${encodeURIComponent(productId)}` +
    `&package=${encodeURIComponent(config.googlePlay.packageName)}`;

  return res.json({
    success: false,
    provider: 'google_play',
    manageUrl,
    message:
      'This subscription is billed by Google Play. Open the Play Store to cancel; access continues until the end of the paid period.',
    subscription: sub,
  });
});