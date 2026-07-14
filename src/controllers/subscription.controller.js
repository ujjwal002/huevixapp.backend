import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { cancelRecurringSubscription } from '../services/payment.service.js';

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
// while the app told them they'd cancelled — the worst possible desync. So for
// google_play we return a manage URL and change nothing locally; the RTDN
// (SUBSCRIPTION_CANCELED / EXPIRED) is the source of truth and updates the row
// when Google confirms it.
//
// Legacy razorpay rows (from before the migration) still cancel locally, and we
// best-effort stop any remaining autopay mandate.
export const cancelSubscription = asyncHandler(async (req, res) => {
  const sub = await prisma.subscription.findUnique({ where: { userId: req.user.id } });
  if (!sub) return res.json({ success: true, subscription: null });

  if (sub.provider === 'google_play') {
    const productId =
      sub.plan === 'YEARLY' ? config.googlePlay.subYearlyId : config.googlePlay.subMonthlyId;
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
  }

  // Legacy Razorpay subscription: stop future charges (best-effort) and let the
  // user keep the time they already paid for instead of cutting access now.
  if (sub.providerRefId) await cancelRecurringSubscription(sub.providerRefId);
  const updated = await prisma.subscription.update({
    where: { userId: req.user.id },
    data: { status: 'CANCELED' }, // keep currentPeriodEnd: paid time is theirs
  });
  res.json({ success: true, subscription: updated });
});
