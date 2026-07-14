import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getAppSettings } from '../services/settings.service.js';
import { ApiError } from '../utils/ApiError.js';
import { saveBuffer } from '../services/storage.service.js';
import { imageExtFromMime, SUPPORTED_IMAGE_LABEL } from '../utils/image.js';

// Store an uploaded image (multer memory file) through the storage layer and
// return its public URL. Writes to local disk or S3 per STORAGE_DRIVER.
async function storeUploadedImage(file) {
  const ext = imageExtFromMime(file.mimetype);
  if (!ext) throw ApiError.badRequest(`Unsupported image type (use ${SUPPORTED_IMAGE_LABEL})`, 'BAD_IMAGE');
  const { url } = await saveBuffer(file.buffer, { folder: 'images', ext });
  return url;
}

// Public — active ads only (used by the feed). Returns nothing while the master
// ad switch is OFF, so house ads can be held back at launch and turned on later
// from the admin with no client change.
export const listSponsored = asyncHandler(async (_req, res) => {
  const { adsEnabled } = await getAppSettings();
  if (!adsEnabled) return res.json({ items: [] });
  const items = await prisma.sponsoredCard.findMany({
    where: { isActive: true },
    orderBy: { createdAt: 'desc' },
  });
  res.json({ items });
});

// Admin — every ad, active or not
export const listAllSponsored = asyncHandler(async (_req, res) => {
  const items = await prisma.sponsoredCard.findMany({ orderBy: { createdAt: 'desc' } });
  res.json({ items });
});

export const createSponsored = asyncHandler(async (req, res) => {
  const { advertiser, title, body, ctaText, ctaUrl, imageUrl } = req.body;
  // An uploaded file is stored to S3/local and takes precedence over any
  // imageUrl string, so existing JSON clients keep working unchanged.
  const storedImageUrl = req.file ? await storeUploadedImage(req.file) : imageUrl || null;
  const item = await prisma.sponsoredCard.create({
    data: {
      advertiser,
      title,
      body,
      ctaText: ctaText || 'Learn more',
      ctaUrl,
      imageUrl: storedImageUrl,
    },
  });
  res.status(201).json(item);
});

export const updateSponsored = asyncHandler(async (req, res) => {
  const data = {};
  for (const k of ['advertiser', 'title', 'body', 'ctaText', 'ctaUrl', 'imageUrl', 'isActive']) {
    if (req.body[k] !== undefined) data[k] = req.body[k];
  }
  // A newly uploaded file replaces the image regardless of any imageUrl field.
  if (req.file) data.imageUrl = await storeUploadedImage(req.file);
  const item = await prisma.sponsoredCard.update({ where: { id: req.params.id }, data });
  res.json(item);
});

export const deleteSponsored = asyncHandler(async (req, res) => {
  await prisma.sponsoredCard.delete({ where: { id: req.params.id } });
  res.json({ success: true });
});
