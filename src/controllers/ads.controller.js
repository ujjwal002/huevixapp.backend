import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { grantAdCredit } from '../services/entitlement.service.js';
import { verifyAdReward } from '../services/ad.service.js';

// POST /ads/reward
// Called by the client AFTER a rewarded ad finishes playing. The client must
// forward a signed reward token; we VERIFY it before granting a bonus speaking
// attempt (capped per day). In mock/dev mode verification is skipped so the
// demo flow works with no setup. See ad.service.js for the production model
// (and the AdMob server-side-verification upgrade path).
export const claimAdReward = asyncHandler(async (req, res) => {
  const verdict = verifyAdReward({ token: req.body?.token, signature: req.body?.signature });
  if (!verdict.ok) {
    throw ApiError.forbidden('Ad reward could not be verified', verdict.reason || 'AD_VERIFICATION_FAILED');
  }

  const result = await grantAdCredit(req.user);
  if (!result.granted) {
    return res.status(200).json({ granted: false, reason: result.reason, ...result });
  }
  res.status(200).json(result);
});