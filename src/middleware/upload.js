import multer from 'multer';
import { ApiError } from '../utils/ApiError.js';

// Shared in-memory image upload for any route that stores an image through the
// storage layer (promos, sponsored house ads — cards keep their own local
// multer). The buffer is handed to storage.saveBuffer(), which writes to local
// disk or S3 depending on STORAGE_DRIVER, so callers never care where it lands.
export const IMAGE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024; // 8MB — matches card image cap

const imageMulter = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: IMAGE_UPLOAD_MAX_BYTES },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image uploads are allowed'));
  },
});

// Wrap multer.single so upload failures surface as clean 400s (oversized file,
// wrong type) rather than a generic 500 from the central error handler.
//
// The field is OPTIONAL: on a non-multipart (JSON) request multer passes through
// untouched, so these routes still accept a JSON body carrying an `imageUrl`
// string and no file. On multipart with no file part, req.file is simply
// undefined and the controller falls back to the string too.
export function uploadImage(field = 'image') {
  const mw = imageMulter.single(field);
  return (req, res, next) =>
    mw(req, res, (err) => {
      if (!err) return next();
      if (err instanceof multer.MulterError) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? 'Image is too large (max 8MB)'
            : `Upload error: ${err.message}`;
        return next(ApiError.badRequest(msg, 'UPLOAD_ERROR'));
      }
      // fileFilter rejection (non-image) or any other multer error.
      return next(ApiError.badRequest(err.message || 'Upload failed', 'UPLOAD_ERROR'));
    });
}