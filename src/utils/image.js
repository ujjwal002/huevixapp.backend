// Central image content-type <-> file-extension mapping, shared by every path
// that persists an image (card / promo / sponsored uploads + re-hosted news
// photos) so they never disagree on how a given type is stored. Returns null for
// types we refuse to store — including SVG, which can carry active content and
// has no place in a media bucket served to other users.
const IMAGE_EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heic',
};

// Accepts a raw mimetype (optionally with a "; charset=..." suffix) and returns
// a bare extension ("jpg") or null if the type isn't an image we store.
export function imageExtFromMime(mimetype) {
  const type = (mimetype || '').split(';')[0].trim().toLowerCase();
  return IMAGE_EXT_BY_MIME[type] || null;
}

// Human-readable list for error messages ("use JPG, PNG, ...").
export const SUPPORTED_IMAGE_LABEL = 'JPG, PNG, WebP, GIF, or HEIC';