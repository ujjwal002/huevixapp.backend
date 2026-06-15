import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from '../config/env.js';

// Minimal storage abstraction. Default driver writes to ./storage and serves it
// via the /static route. Swap implementation for S3/GCS in production without
// touching callers.
const ROOT = path.resolve(process.cwd(), 'storage');

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function saveBuffer(buffer, { folder = 'misc', ext = 'bin' } = {}) {
  if (config.storage.driver !== 'local') {
    throw new Error(`Storage driver "${config.storage.driver}" not implemented`);
  }
  const dir = path.join(ROOT, folder);
  await ensureDir(dir);
  const filename = `${randomUUID()}.${ext}`;
  await fs.writeFile(path.join(dir, filename), buffer);
  const publicPath = `${folder}/${filename}`;
  return {
    key: publicPath,
    url: `${config.storage.publicBaseUrl}/${publicPath}`,
  };
}

export const STORAGE_ROOT = ROOT;
