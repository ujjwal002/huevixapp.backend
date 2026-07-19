import { prisma } from '../db/prisma.js';
import {
  fetchText,
  extractCandidateLinks,
  looksLikeNotification,
  contentHash,
  extractLooseUrls,
} from './govCrawl.parse.js';

// Government-job page crawler.
//
// Strategy per source: fetch the listing page → harvest anchor links → keep
// the ones that look like recruitment notifications → diff against what we've
// seen (unique [sourceId, url]) → brand-new links become GovCrawlItem rows
// with status NEW, which the extractor turns into unverified GovJob rows.
//
// Politeness: we hit each source's LISTING page a few times a day (per its
// crawlEveryHours), sequentially, with a delay and an identifying User-Agent.
// These are public notice boards published for citizens; we link back to the
// official PDF and never republish page content.
//
// Known limitation (v1): sites that render their notice list with client-side
// JS won't expose links in raw HTML — those sources will report 0 links.
// That's surfaced in the crawl summary so you can spot them and either add
// jobs manually or point source.url at a server-rendered listing page.
// Pure fetch/parse helpers live in govCrawl.parse.js.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Crawl one source: fetch listing page, diff, record new items.
 * Never throws — failures land in GovCrawlPage.lastError and the returned
 * summary so one broken gov site can't kill the whole run.
 */
export async function crawlSource(source, { now = new Date(), backfillLimit = 10 } = {}) {
  const summary = {
    source: source.shortName,
    fetched: false,
    changed: false,
    links: 0,
    newItems: 0,
    error: null,
  };
  try {
    const page = await fetchText(source.url);
    summary.fetched = true;
    if (!page.ok) throw new Error(`HTTP ${page.status}`);

    // HTML anchors first; a page with ZERO anchors is almost certainly a JSON
    // API response (SPA notice boards: SSC/RRB/RBI) — harvest loose URLs then.
    let harvested = extractCandidateLinks(page.text, page.finalUrl);
    if (harvested.length === 0) harvested = extractLooseUrls(page.text, page.finalUrl);
    const candidates = harvested.filter(looksLikeNotification);
    summary.links = candidates.length;
    const hash = contentHash(candidates);

    const prev = await prisma.govCrawlPage.findUnique({ where: { sourceId: source.id } });
    summary.changed = !prev || prev.contentHash !== hash;

    // FIRST crawl of a source sees its entire historical archive (real CSBC
    // run: 190 links, most of them years old). Extracting all of that wastes
    // LLM calls on closed jobs, so the baseline keeps only the first
    // `backfillLimit` links (gov sites list newest at the top) as NEW and
    // parks the rest as IGNORED. Every later crawl only queues genuinely
    // new links, because [sourceId, url] is unique.
    // A prev row whose hash is '' came from a FAILED crawl (error upsert) —
    // the first SUCCESSFUL crawl must still baseline, or a source that errors
    // once would later dump its whole archive into the LLM queue.
    const isFirstCrawl = !prev || prev.contentHash === '';

    if (summary.changed) {
      let kept = 0;
      for (const link of candidates) {
        const existing = await prisma.govCrawlItem.findUnique({
          where: { sourceId_url: { sourceId: source.id, url: link.url } },
        });
        if (existing) {
          await prisma.govCrawlItem.update({
            where: { id: existing.id },
            data: { lastSeenAt: now },
          });
        } else {
          const archive = isFirstCrawl && kept >= backfillLimit;
          await prisma.govCrawlItem.create({
            data: {
              sourceId: source.id,
              url: link.url,
              title: link.title || null,
              status: archive ? 'IGNORED' : 'NEW',
              error: archive ? 'baseline archive (pre-dates first crawl)' : null,
              lastSeenAt: now,
            },
          });
          if (archive) summary.archived += 1;
          else {
            summary.newItems += 1;
            kept += 1;
          }
        }
      }
    }

    await prisma.govCrawlPage.upsert({
      where: { sourceId: source.id },
      create: {
        sourceId: source.id,
        contentHash: hash,
        lastCrawledAt: now,
        lastChangedAt: summary.changed ? now : null,
      },
      update: {
        contentHash: hash,
        lastCrawledAt: now,
        ...(summary.changed ? { lastChangedAt: now } : {}),
        lastError: null,
      },
    });
  } catch (err) {
    summary.error = err.message;
    await prisma.govCrawlPage
      .upsert({
        where: { sourceId: source.id },
        create: {
          sourceId: source.id,
          contentHash: '',
          lastCrawledAt: now,
          lastError: err.message,
        },
        update: { lastCrawledAt: now, lastError: err.message },
      })
      .catch(() => {});
  }
  return summary;
}

/** Which active sources are due, honoring each one's crawlEveryHours? */
export async function dueSources({ now = new Date(), force = false, shortName = null } = {}) {
  const sources = await prisma.govJobSource.findMany({
    where: { active: true, ...(shortName ? { shortName } : {}) },
    orderBy: { shortName: 'asc' },
  });
  if (force || shortName) return sources;
  const pages = await prisma.govCrawlPage.findMany({
    where: { sourceId: { in: sources.map((s) => s.id) } },
  });
  const lastBySource = new Map(pages.map((p) => [p.sourceId, p.lastCrawledAt]));
  return sources.filter((s) => {
    const last = lastBySource.get(s.id);
    if (!last) return true;
    return now - last >= s.crawlEveryHours * 3600_000;
  });
}

/** Crawl all due sources sequentially with a politeness gap. */
export async function crawlAllDue({
  now = new Date(),
  force = false,
  shortName = null,
  delayMs = 2000,
  backfillLimit = 10,
} = {}) {
  const sources = await dueSources({ now, force, shortName });
  const results = [];
  for (const source of sources) {
    results.push(await crawlSource(source, { now, backfillLimit }));
    if (delayMs) await sleep(delayMs);
  }
  return results;
}