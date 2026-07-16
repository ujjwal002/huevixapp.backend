import { asyncHandler } from '../utils/asyncHandler.js';
import { collectMetrics } from '../services/metrics.service.js';

// GET /admin/metrics?days=30 — full investor-grade metrics JSON (admin only).
export const getMetrics = asyncHandler(async (req, res) => {
  res.json(await collectMetrics({ days: req.query.days }));
});