/**
 * Fix stored media URLs saved with a localhost/dev base instead of S3.
 *
 * Root cause: STORAGE_PUBLIC_BASE_URL was set to http://localhost:4000/static,
 * so every saved URL (card images AND tts audio) got a localhost prefix even
 * though STORAGE_DRIVER=s3 uploaded the FILES to S3 correctly. This rewrites
 * those URLs to the real S3 base. It does NOT move files — the bytes are already
 * in S3 under the same key (the path after /static/).
 *
 * PREREQUISITE — fix .env FIRST so config points at S3:
 *   STORAGE_DRIVER=s3
 *   (delete STORAGE_PUBLIC_BASE_URL so it derives the bucket URL,
 *    or set it to https://huevix-app-prod.s3.ap-south-1.amazonaws.com)
 *
 * Per card, for BOTH imageUrl and audioUrl:
 *   - dev "/static/<key>" url -> HEAD-check <key> in S3, then rewrite to
 *     <S3_BASE>/<key>. If the object is NOT in S3 (older local-only file):
 *       image -> null;  audio -> null + audioStatus PENDING (regenerate later).
 *   - already an S3 url, or null -> left untouched.
 *
 * DRY RUN by default. Add --apply to write.
 *   node scripts/fix-storage-urls.js
 *   node scripts/fix-storage-urls.js --apply
 *
 * IMPORTANT: do NOT re-run fix-card-images.js after this — the old news URLs are
 * already gone from the DB, so it would null everything. Use THIS script.
 */
import { prisma } from '../src/db/prisma.js';
import { config } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');
const S3_BASE = config.storage.publicBaseUrl;

if (/localhost|127\.0\.0\.1/.test(S3_BASE)) {
  console.error(
    `Refusing to run: storage base is still "${S3_BASE}".\n` +
      `Fix your .env first (delete STORAGE_PUBLIC_BASE_URL or point it at S3), then re-run.`
  );
  process.exit(1);
}

// Pull the storage key ("images/x.jpg") out of a dev "/static/<key>" URL.
function keyFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/static\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

// Only touch dev/localhost URLs; leave real S3 URLs and nulls alone.
function needsFix(url) {
  return !!url && !url.startsWith(S3_BASE) && /\/static\//.test(url);
}

// Does the object exist in S3? (best-effort; on error assume "no")
let _s3, _Head;
async function existsInS3(key) {
  if (!_s3) {
    const { S3Client, HeadObjectCommand } = await import('@aws-sdk/client-s3');
    _Head = HeadObjectCommand;
    _s3 = new S3Client({
      region: config.storage.s3.region,
      ...(config.storage.s3.endpoint
        ? { endpoint: config.storage.s3.endpoint, forcePathStyle: config.storage.s3.forcePathStyle }
        : {}),
    });
  }
  try {
    await _s3.send(new _Head({ Bucket: config.storage.s3.bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  console.log(`[fix-storage-urls] mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
  console.log(`[fix-storage-urls] S3 base: ${S3_BASE}\n`);

  const cards = await prisma.card.findMany({
    select: { id: true, imageUrl: true, audioUrl: true },
  });
  let imgFixed = 0, imgMissing = 0, audFixed = 0, audMissing = 0, untouched = 0;

  for (const c of cards) {
    const data = {};

    if (needsFix(c.imageUrl)) {
      const key = keyFromUrl(c.imageUrl);
      if (key && (await existsInS3(key))) { data.imageUrl = `${S3_BASE}/${key}`; imgFixed++; }
      else { data.imageUrl = null; imgMissing++; }
    }

    if (needsFix(c.audioUrl)) {
      const key = keyFromUrl(c.audioUrl);
      if (key && (await existsInS3(key))) { data.audioUrl = `${S3_BASE}/${key}`; audFixed++; }
      else { data.audioUrl = null; data.audioStatus = 'PENDING'; audMissing++; }
    }

    if (Object.keys(data).length === 0) { untouched++; continue; }
    console.log(`  ${c.id}  fixed: ${Object.keys(data).join(', ')}`);
    if (APPLY) await prisma.card.update({ where: { id: c.id }, data });
  }

  console.log(`\n----- summary -----`);
  console.log(`images -> S3    : ${imgFixed}`);
  console.log(`images missing  : ${imgMissing} (nulled)`);
  console.log(`audio  -> S3    : ${audFixed}`);
  console.log(`audio  missing  : ${audMissing} (nulled + set PENDING)`);
  console.log(`untouched cards : ${untouched}`);
  if (!APPLY) console.log(`\nDRY RUN — nothing changed. Re-run with --apply to write.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[fix-storage-urls] failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});