/**
 * Gov-jobs crawl cron — watch the 25 official sources, queue new notifications,
 * extract a bounded batch into unverified GovJob rows for admin review.
 * Cron (hourly; each source's own crawlEveryHours decides if it's actually due):
 *   15 * * * * cd /home/ubuntu/huevixapp.backend && node scripts/govjobs-crawl.js >> ~/govjobs-cron.log 2>&1
 * Flags: --source=BPSC  --force  --no-extract  --extract-limit=N  --backfill-limit=N  --crawl-only
 */
import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { crawlAllDue } from '../src/services/govCrawl.service.js';
import { extractPending } from '../src/services/govExtract.service.js';

function arg(name, fallback = undefined) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}
const hasFlag = (f) => process.argv.includes(`--${f}`);

async function main() {
  const shortName = arg('source', null);
  const force = hasFlag('force') || !!shortName;
  const extract = !hasFlag('no-extract') && !hasFlag('crawl-only');
  const extractLimit = Number(arg('extract-limit', process.env.GOVJOBS_EXTRACT_LIMIT || 5));
  const backfillLimit = Number(arg('backfill-limit', process.env.GOVJOBS_BACKFILL_LIMIT || 10));

  // Phase 1: crawl due listing pages.
  const crawled = await crawlAllDue({ force, shortName, backfillLimit });
  let newItems = 0;
  for (const r of crawled) {
    newItems += r.newItems;
    const tag = r.error
      ? `ERROR ${r.error}`
      : `links=${r.links} new=${r.newItems}${r.changed ? '' : ' (unchanged)'}`;
    console.log(`[govjobs] ${r.source.padEnd(6)} ${tag}`);
  }
  console.log(
    `[govjobs] crawled=${crawled.length} sources, discovered=${newItems} new notifications`
  );

  // Phase 2: extract a bounded batch of queued notifications (LLM cost control).
  if (extract) {
    const results = await extractPending({ limit: extractLimit });
    const ok = results.filter((r) => r.ok).length;
    const ignored = results.filter((r) => r.ignored).length;
    for (const r of results) {
      console.log(
        r.ok
          ? `[govjobs] extracted → job ${r.jobId}${r.deduped ? ' (deduped)' : ''}`
          : r.ignored
            ? `[govjobs] classified not-a-job: ${r.error}`
            : `[govjobs] extract FAILED item ${r.itemId}: ${r.error}`
      );
    }
    console.log(
      `[govjobs] extracted=${ok}/${results.length}${ignored ? `, classified-not-a-job=${ignored}` : ''} (pending jobs need admin verify)`
    );
  }

  // Health hint: pending review + queue depth, so the log line is a dashboard.
  const [pendingJobs, queuedItems] = await Promise.all([
    prisma.govJob.count({ where: { verified: false } }),
    prisma.govCrawlItem.count({ where: { status: 'NEW' } }),
  ]);
  console.log(`[govjobs] awaiting-review=${pendingJobs} jobs, queue=${queuedItems} items`);
}

main()
  .catch((e) => {
    console.error('[govjobs] fatal:', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());