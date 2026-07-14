/**
 * One-off maintenance: fix Card.imageUrl values that predate the S3 switch.
 *
 * For every card whose imageUrl is NOT already on our S3/CDN base:
 *   - a reachable public http(s) image  -> re-host it into our bucket, update the row
 *   - a dead / blocked URL               -> set imageUrl = null (clean no-image
 *                                           fallback instead of a broken blank)
 *   - a localhost / private-LAN / relative URL -> unreachable from here, null it
 *   - already on our base, or already null     -> left untouched
 *
 * DRY RUN by default (reports what it WOULD do, writes nothing). Add --apply to
 * actually re-host + update the database.
 *
 *   node scripts/fix-card-images.js            # preview
 *   node scripts/fix-card-images.js --apply    # do it for real
 *
 * REQUIRES: the saveImageFromUrl() addition in src/services/storage.service.js,
 * and must run with your PROD env (DATABASE_URL + STORAGE_DRIVER=s3 + bucket +
 * AWS creds) so re-hosted images actually land in S3.
 */
import { prisma } from '../src/db/prisma.js';
import { saveImageFromUrl } from '../src/services/storage.service.js';
import { config } from '../src/config/env.js';

const APPLY = process.argv.includes('--apply');
const PUBLIC_BASE = config.storage.publicBaseUrl; // e.g. https://huevix-app-prod.s3.ap-south-1.amazonaws.com

// Already served from our own storage (S3/CDN)? Then leave it alone.
function isAlreadyHosted(url) {
  if (!url) return false;
  if (url.startsWith(PUBLIC_BASE)) return true;
  const bucket = config.storage.s3?.bucket; // catch raw bucket URL even if a CDN base is set
  return !!bucket && url.includes(`${bucket}.s3.`);
}

// Worth attempting a re-download? Only public http(s) hosts. localhost /
// private-LAN / relative can't be reached from here — those are just dead.
function isReDownloadable(url) {
  if (!url || !/^https?:\/\//i.test(url)) return false;
  const host = url.replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  const isPrivate =
    /^(localhost$|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.0\.0\.0$)/.test(host);
  return !isPrivate;
}

async function main() {
  console.log(`[fix-card-images] mode: ${APPLY ? 'APPLY (writing changes)' : 'DRY RUN (no changes)'}`);
  console.log(`[fix-card-images] our storage base: ${PUBLIC_BASE}\n`);

  const cards = await prisma.card.findMany({ select: { id: true, title: true, imageUrl: true } });
  console.log(`Scanning ${cards.length} cards...\n`);

  let ok = 0, noImage = 0, rehosted = 0, dead = 0, staleLocal = 0;

  for (const card of cards) {
    const url = card.imageUrl;
    const label = `${card.id}  "${(card.title || '').slice(0, 40)}"`;

    if (url === null) { noImage++; continue; }
    if (isAlreadyHosted(url)) { ok++; continue; }

    if (isReDownloadable(url)) {
      if (!APPLY) {
        console.log(`  WOULD RE-HOST  ${label}\n                 from ${url}`);
        rehosted++;
        continue;
      }
      const hosted = await saveImageFromUrl(url).catch(() => null);
      if (hosted?.url) {
        await prisma.card.update({ where: { id: card.id }, data: { imageUrl: hosted.url } });
        console.log(`  RE-HOSTED      ${label}\n                 -> ${hosted.url}`);
        rehosted++;
      } else {
        await prisma.card.update({ where: { id: card.id }, data: { imageUrl: null } });
        console.log(`  DEAD -> NULL   ${label}\n                 (unreachable: ${url})`);
        dead++;
      }
    } else {
      if (APPLY) {
        await prisma.card.update({ where: { id: card.id }, data: { imageUrl: null } });
      }
      console.log(`  ${APPLY ? 'NULLED       ' : 'WOULD NULL   '} ${label}\n                 (stale local URL: ${url})`);
      staleLocal++;
    }
  }

  console.log(`\n----- summary -----`);
  console.log(`already on S3/CDN     : ${ok}`);
  console.log(`no image (null)       : ${noImage}`);
  console.log(`re-hosted to S3       : ${rehosted}${APPLY ? '' : ' (would attempt)'}`);
  console.log(`dead -> nulled        : ${dead}${APPLY ? '' : ' (unknown until --apply)'}`);
  console.log(`stale local -> nulled : ${staleLocal}`);
  if (!APPLY) console.log(`\nDRY RUN — nothing changed. Re-run with --apply to write.`);

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[fix-card-images] failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});