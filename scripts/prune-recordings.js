// Recordings retention job.
//
// Speaking recordings are PII and are only useful for short-term review/debug,
// but they accumulate forever otherwise (storage cost + standing privacy
// liability). This deletes the stored audio for SpeakingAttempts older than a
// retention window and nulls their audioUrl, keeping the scores/feedback rows.
//
// Run it on a schedule (cron / a platform scheduler):
//   RETENTION_DAYS=30 node scripts/prune-recordings.js
//
// With STORAGE_DRIVER=s3 you can ALSO (or instead) set an S3 lifecycle rule on
// the `recordings/` prefix to expire objects — that handles the bytes; this job
// additionally clears the DB pointer so the app never offers a dead URL.

import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { deleteObject } from '../src/services/storage.service.js';

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS || 30);
const BATCH = Number(process.env.PRUNE_BATCH || 500);

async function main() {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  console.log(
    `Pruning recordings older than ${RETENTION_DAYS} days (before ${cutoff.toISOString()})`
  );

  let totalDeleted = 0;
  // Loop in batches so a large backlog doesn't load everything into memory.
  for (;;) {
    const attempts = await prisma.speakingAttempt.findMany({
      where: { createdAt: { lt: cutoff }, audioUrl: { not: null } },
      select: { id: true, audioUrl: true },
      take: BATCH,
    });
    if (attempts.length === 0) break;

    for (const a of attempts) {
      await deleteObject(a.audioUrl).catch(() => {});
      await prisma.speakingAttempt.update({ where: { id: a.id }, data: { audioUrl: null } });
      totalDeleted += 1;
    }
    console.log(`  ...processed ${totalDeleted}`);
    if (attempts.length < BATCH) break;
  }

  console.log(`Done. Cleared ${totalDeleted} recording(s).`);
}

main()
  .catch((e) => {
    console.error('[prune-recordings] failed:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
