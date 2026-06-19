import { asyncHandler } from '../utils/asyncHandler.js';
import { getAppSettings, updateAppSettings } from '../services/settings.service.js';

// GET /admin/settings — current app-wide settings (admin only).
export const getSettings = asyncHandler(async (_req, res) => {
  const settings = await getAppSettings();
  res.json(settings);
});

// PATCH /admin/settings — flip the master ad switch / change the feed cadence.
export const updateSettings = asyncHandler(async (req, res) => {
  const settings = await updateAppSettings(req.body);
  res.json(settings);
});