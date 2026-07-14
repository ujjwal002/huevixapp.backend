/**
 * Generic RSS provider — FREE, no API key.
 * Env: NEWS_RSS_FEEDS="https://feeds.bbci.co.uk/news/rss.xml,https://..."
 */
import { normalizeArticle } from './types.js';

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, 'i'));
  if (!m) return '';
  return m[1]
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, '')
    .trim();
}

function enclosureUrl(itemXml) {
  const m =
    itemXml.match(/<enclosure[^>]*url="([^"]+)"/i) ||
    itemXml.match(/<media:content[^>]*url="([^"]+)"/i) ||
    itemXml.match(/<media:thumbnail[^>]*url="([^"]+)"/i);
  return m ? m[1] : null;
}

async function fetchFeed(url, language) {
  let xml;
  try {
    const res = await fetch(url);
    xml = await res.text();
  } catch (e) {
    console.error('[news:rss] fetch error', url, e.message);
    return [];
  }
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const out = [];
  for (const item of items) {
    const article = normalizeArticle({
      externalId: tag(item, 'guid') || tag(item, 'link'),
      title: tag(item, 'title'),
      description: tag(item, 'description'),
      url: tag(item, 'link'),
      imageUrl: enclosureUrl(item),
      source: (() => {
        try {
          return new URL(url).hostname.replace('www.', '');
        } catch {
          return null;
        }
      })(),
      publishedAt: tag(item, 'pubDate'),
      language,
    });
    if (article) out.push(article);
  }
  return out;
}

export const rssProvider = {
  name: 'rss',

  enabled() {
    return !!process.env.NEWS_RSS_FEEDS;
  },

  async fetch({ limit = 10, language = 'en' } = {}) {
    const feeds = (process.env.NEWS_RSS_FEEDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!feeds.length) return [];

    const all = [];
    for (const feed of feeds) {
      const items = await fetchFeed(feed, language);
      all.push(...items);
      if (all.length >= limit) break;
    }
    return all.slice(0, limit);
  },
};