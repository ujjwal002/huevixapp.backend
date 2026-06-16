import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';

// Public — active ads only (used by the feed)
export const listSponsored = asyncHandler(async (_req, res) => {
  const items = await prisma.sponsoredCard.findMany({ where: { isActive: true }, orderBy: { createdAt: 'desc' } });
  res.json({ items });
});

// Admin — every ad, active or not
export const listAllSponsored = asyncHandler(async (_req, res) => {
  const items = await prisma.sponsoredCard.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ items });
});

export const createSponsored = asyncHandler(async (req, res) => {
  const { advertiser, title, body, ctaText, ctaUrl, imageUrl } = req.body;
  const item = await prisma.sponsoredCard.create({
    data: { advertiser, title, body, ctaText: ctaText || 'Learn more', ctaUrl, imageUrl: imageUrl || null },
  });
  res.status(201).json(item);
});

export const updateSponsored = asyncHandler(async (req, res) => {
  const data = {};
  for (const k of ['advertiser', 'title', 'body', 'ctaText', 'ctaUrl', 'imageUrl', 'isActive']) {
    if (req.body[k] !== undefined) data[k] = req.body[k];
  }
  const item = await prisma.sponsoredCard.update({ where: { id: req.params.id }, data });
  res.json(item);
});

export const deleteSponsored = asyncHandler(async (req, res) => {
  await prisma.sponsoredCard.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});