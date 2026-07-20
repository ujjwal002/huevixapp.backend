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
  // World slice: international affairs (summits, global orgs, conflicts, IR)
  // are a scoring area in Indian competitive exams, and a pure country=in
  // fetch can miss them. Default ~1/3 of the batch goes to a global fetch;
  // override with NEWS_WORLD_LIMIT or --world-limit (0 disables).
  const worldLimit = Math.min(
    limit,
    Math.max(
      0,
      Number(arg('world-limit', process.env.NEWS_WORLD_LIMIT ?? Math.max(1, Math.round(limit / 3))))
    )
  );
  const indiaLimit = limit - worldLimit;

  console.log('[news] providers:', JSON.stringify(listProviders()));
  console.log(`[news] batch split: india=${indiaLimit} world=${worldLimit}`);
  if (dry) console.log('[news] DRY RUN — will not publish');

  const batches = [];
  if (indiaLimit > 0) {
    batches.push(
      await runNewsBatch({
        limit: indiaLimit,
        // Current-affairs defaults: Indian news across the exam-relevant source
        // categories. Override with NEWS_CATEGORIES / NEWS_COUNTRY.
        categories:
          process.env.NEWS_CATEGORIES || 'politics,business,science,technology,world,sports',
        country: process.env.NEWS_COUNTRY || 'in',
        language: process.env.NEWS_LANGUAGE || 'en',
        targetLanguage: 'en',
        publish: !dry,
      })
    );
  }
  if (worldLimit > 0) {
    batches.push(
      await runNewsBatch({
        limit: worldLimit,
        // Global fetch — deliberately NOT restricted to India. The summarizer
        // normalizes these onto the 'international' category.
        categories: process.env.NEWS_WORLD_CATEGORIES || 'world,politics',
        country: undefined,
        language: process.env.NEWS_LANGUAGE || 'en',
        targetLanguage: 'en',
        publish: !dry,
      })
    );
  }

  // Merge the slices for logging + the single batch push.
  const result = batches.reduce(
    (acc, r) => ({
      provider: r.provider || acc.provider,
      fetched: acc.fetched + r.fetched,
      published: acc.published + r.published,
      skipped: acc.skipped + r.skipped,
      filtered: acc.filtered + r.filtered,
      titles: [...acc.titles, ...r.titles],
      cards: [...acc.cards, ...(r.cards || [])],
    }),
    { provider: null, fetched: 0, published: 0, skipped: 0, filtered: 0, titles: [], cards: [] }
  );

  console.log(
    `[news] provider=${result.provider} fetched=${result.fetched} published=${result.published} skipped=${result.skipped}`
  );
  result.titles.forEach((t) => console.log('   •', t));

  if (notify && !dry && result.cards.length > 0) {
    // ONE notification PER article (Inshorts-style): each headline is its own
    // reason to open the app, and each tap deep-links to that exact story via
    // the app's NEW_CARD route. Sent one by one with a gap — a burst of 7 at
    // once reads as spam and gets the app muted or uninstalled.
    //   NEWS_NOTIFY_GAP_SECONDS  gap between notifications (default 120)
    //   NEWS_NOTIFY_LIMIT        max per batch, 0 = all (default 0)
    const gapMs = Math.max(5, Number(process.env.NEWS_NOTIFY_GAP_SECONDS) || 120) * 1000;
    const cap = Math.max(0, Number(process.env.NEWS_NOTIFY_LIMIT) || 0);
    const toNotify = cap > 0 ? result.cards.slice(0, cap) : result.cards;
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    console.log(`[news] notifying ${toNotify.length} article(s), one every ${gapMs / 1000}s`);
    for (let i = 0; i < toNotify.length; i++) {
      const c = toNotify[i];
      // Body = the first exam pointer (a short, concrete fact) — the best
      // hook we have. Falls back to a simple tap prompt for fallback cards.
      const firstPoint = (c.keyPoints || '').split('\n').map((s) => s.trim()).filter(Boolean)[0];
      await pushToAll({
        title: c.title,
        body: firstPoint || 'Tap to read today\u2019s update',
        data: { type: 'NEW_CARD', cardId: c.id },
      });
      console.log(`[news] notified ${i + 1}/${toNotify.length}: ${c.title}`);
      if (i < toNotify.length - 1) await sleep(gapMs);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[news] fatal', e);
  try {
    await prisma.$disconnect();
  } catch {
    /* already disconnected */
  }
  process.exit(1);
});