/**
 * News fetch cron — fetch real news, summarize, publish, send ONE batch push.
 * Cron (4 batches/day ~7 each = ~28/day, 08:00/12:00/16:00/20:00 IST):
 *   30 2,6,10,14 * * * cd /home/ubuntu/huevixapp.backend && node scripts/news-fetch.js >> ~/news-cron.log 2>&1
 * Flags: --limit=N  --no-notify  --dry
 */
import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { runNewsBatch } from '../src/news/publish.js';
import { pushToAll } from '../src/services/push.service.js';
import { listProviders } from '../src/news/registry.js';

function arg(name, fallback = undefined) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : fallback;
}
const hasFlag = (f) => process.argv.includes(`--${f}`);

async function main() {
  const notify = !hasFlag('no-notify');
  const dry = hasFlag('dry');
  const limit = Number(arg('limit', process.env.NEWS_BATCH_LIMIT || 7));

  console.log('[news] providers:', JSON.stringify(listProviders()));
  if (dry) console.log('[news] DRY RUN — will not publish');

  const result = await runNewsBatch({
    limit,
    categories: process.env.NEWS_CATEGORIES,
    country: process.env.NEWS_COUNTRY,
    language: process.env.NEWS_LANGUAGE || 'en',
    targetLanguage: 'en',
    publish: !dry,
  });

  console.log(
    `[news] provider=${result.provider} fetched=${result.fetched} published=${result.published} skipped=${result.skipped}`
  );
  result.titles.forEach((t) => console.log('   •', t));

  if (notify && !dry && result.published > 0) {
    const n = result.published;
    await pushToAll({
      title: n === 1 ? 'New story on Huevix' : `${n} new stories on Huevix`,
      body:
        n === 1
          ? result.titles[0]
          : `Fresh reads are in — ${result.titles.slice(0, 2).join(' · ')}${n > 2 ? ' and more' : ''}`,
      data: { type: 'NEWS_BATCH' },
    });
    console.log(`[news] pushed 1 batch notification for ${n} stories`);
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[news] fatal', e);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});