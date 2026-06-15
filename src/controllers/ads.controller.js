import { asyncHandler } from '../utils/asyncHandler.js';
import { grantAdCredit } from '../services/entitlement.service.js';

// POST /ads/reward
// Called by the client AFTER a rewarded ad finishes playing. Grants the user a
// bonus speaking attempt (capped per day). This monetizes free users AND lets
// them taste the paid feature again -> drives conversion.
//
// SECURITY NOTE: for production, verify the ad with your ad network's
// server-side callback (AdMob SSV) before granting, so users can't spoof this.
export const claimAdReward = asyncHandler(async (req, res) => {
  const result = await grantAdCredit(req.user);
  if (!result.granted) {
    return res.status(200).json({ granted: false, reason: result.reason, ...result });
  }
  res.status(200).json(result);
});
