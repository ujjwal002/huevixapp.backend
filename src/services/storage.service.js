import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';

// Storage abstraction. Flip the WHOLE app between local disk and S3 with the
// single STORAGE_DRIVER env var (local | s3). Callers never change.
//   - local: writes under ./storage, served via the /static route.
//   - s3:    uploads to S3_BUCKET. PUBLIC assets (TTS audio, article images)
//            resolve via STORAGE_PUBLIC_BASE_URL / a derived bucket URL; PRIVATE
//            recordings are handed to their owner via a short-lived presigned
//            URL (the bucket itself stays private).
const ROOT = path.resolve(process.cwd(), 'storage');

const isS3 = () => config.storage.driver === 's3';

// Lazily-created, cached S3 client. @aws-sdk/* is an OPTIONAL dependency, loaded
// only when STORAGE_DRIVER=s3 — mirroring how razorpay/azure are imported, so
// local installs need no AWS packages.
let _s3;
async function s3Client() {
  if (_s3) return _s3;
  const { S3Client } = await import('@aws-sdk/client-s3');
  _s3 = new S3Client({
    region: config.storage.s3.region,
    // Credentials are picked up from the standard AWS env vars / IAM role.
    ...(config.storage.s3.endpoint
      ? { endpoint: config.storage.s3.endpoint, forcePathStyle: config.storage.s3.forcePathStyle }
      : {}),
  });
  return _s3;
}

// Minimal ext -> content-type map so S3 serves audio/images with the right type
// (the browser needs it to play <audio> / render <img>).
const MIME = {
  mp3: 'audio/mpeg', m4a: 'audio/mp4', mp4: 'audio/mp4', wav: 'audio/wav',
  webm: 'audio/webm', ogg: 'audio/ogg', opus: 'audio/ogg', aac: 'audio/aac',
  flac: 'audio/flac', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
  webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', txt: 'text/plain',
};
function contentTypeFor(ext) {
  return MIME[(ext || '').toLowerCase()] || 'application/octet-stream';
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

// Persist a buffer and return its storage { key, url }.
//   key -> stable relative path ("recordings/<uuid>.webm"); used for private,
//          authenticated retrieval (recordings).
//   url -> public URL (driver-correct via config.storage.publicBaseUrl); stored
//          on cards for TTS audio / images.
export async function saveBuffer(buffer, { folder = 'misc', ext = 'bin' } = {}) {
  const filename = `${randomUUID()}.${ext}`;
  const key = `${folder}/${filename}`;
  const url = `${config.storage.publicBaseUrl}/${key}`;

  if (isS3()) {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await s3Client();
    await client.send(
      new PutObjectCommand({
        Bucket: config.storage.s3.bucket,
        Key: key,
        Body: buffer,
        ContentType: contentTypeFor(ext),
      })
    );
    return { key, url };
  }

  if (config.storage.driver !== 'local') {
    throw new Error(`Storage driver "${config.storage.driver}" not implemented`);
  }

  const dir = path.join(ROOT, folder);
  await ensureDir(dir);
  await fs.writeFile(path.join(dir, filename), buffer);
  return { key, url };
}

// Resolve a stored key to an absolute on-disk path (LOCAL driver only), with a
// path-traversal guard: a crafted key can never escape the storage root.
// Returns null if the key is unsafe or the file does not exist.
export function resolveLocalPath(key) {
  const resolved = path.resolve(ROOT, key);
  const root = path.resolve(ROOT) + path.sep;
  if (!resolved.startsWith(root) || !fsSync.existsSync(resolved)) return null;
  return resolved;
}

// Short-lived presigned GET URL for a PRIVATE object (S3 driver only). Lets the
// authenticated owner fetch a recording without exposing the bucket publicly.
export async function getPresignedDownloadUrl(key, { expiresIn = 300 } = {}) {
  if (!isS3()) throw new Error('getPresignedDownloadUrl is only available with STORAGE_DRIVER=s3');
  const { GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const client = await s3Client();
  return getSignedUrl(
    client,
    new GetObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }),
    { expiresIn }
  );
}

// Delete a stored object by its key (driver-correct). Used by retention jobs
// (e.g. pruning old recordings). Best-effort: returns true on success, false if
// the object was missing or the key was unsafe — never throws on "not found".
export async function deleteObject(key) {
  if (!key) return false;

  if (isS3()) {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const client = await s3Client();
    try {
      await client.send(new DeleteObjectCommand({ Bucket: config.storage.s3.bucket, Key: key }));
      return true;
    } catch {
      return false;
    }
  }

  const resolved = resolveLocalPath(key);
  if (!resolved) return false; // unsafe key or already gone
  try {
    await fs.unlink(resolved);
    return true;
  } catch {
    return false;
  }
}

export const STORAGE_ROOT = ROOT;