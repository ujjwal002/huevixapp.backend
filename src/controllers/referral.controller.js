import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import * as referral from '../services/referral.service.js';

// GET /referrals/me — my code, share link, progress, earnings, payout eligibility.
export const getMyReferral = asyncHandler(async (req, res) => {
  res.json(await referral.referralSummary(req.user.id));
});

// GET /referrals/payouts — my payout request history.
export const myPayouts = asyncHandler(async (req, res) => {
  res.json({ items: await referral.listMyPayouts(req.user.id) });
});

// POST /referrals/payout — request a UPI payout of the available balance.
export const requestPayout = asyncHandler(async (req, res) => {
  const result = await referral.requestPayout(req.user.id, req.body.upiId);
  if (result.error === 'NOT_ENOUGH_REFERRALS') {
    throw ApiError.badRequest(
      `You need ${result.need} more qualified referral(s) before you can withdraw.`,
      'NOT_ENOUGH_REFERRALS'
    );
  }
  if (result.error === 'NOTHING_AVAILABLE') {
    throw ApiError.badRequest('You have no balance available to withdraw yet.', 'NOTHING_AVAILABLE');
  }
  res.status(201).json(result.payout);
});

// --- Admin -----------------------------------------------------------------
export const adminListPayouts = asyncHandler(async (_req, res) => {
  res.json({ items: await referral.listPayoutRequests() });
});

export const adminPayPayout = asyncHandler(async (req, res) => {
  const ok = await referral.markPayoutPaid(req.params.id, req.body?.reference);
  if (!ok) throw ApiError.badRequest('Payout is not pending (already paid or rejected).', 'NOT_PENDING');
  res.json({ ok: true });
});

export const adminRejectPayout = asyncHandler(async (req, res) => {
  const ok = await referral.rejectPayout(req.params.id, req.body?.reason);
  if (!ok) throw ApiError.badRequest('Payout is not pending.', 'NOT_PENDING');
  res.json({ ok: true });
});