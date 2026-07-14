/**
 * NewsData.io provider — https://newsdata.io/documentation
 * Env:
 *   NEWSDATA_API_KEY   your API key (required)
 *   NEWS_TIMEFRAME     optional; limit to recent news. Hours as a number
 *                      (e.g. "6" = last 6 hours) or minutes as "Nm"
 *                      (e.g. "48m"). Omit for the newest available.
 *
 * Free tier: 200 credits/day, 10 articles/request. We fetch in pages of 10.
 * The /latest endpoint returns newest-first, so results are already recent.
 */
import { normalizeArticle } from './types.js';

const BASE = 'https://newsdata.io/api/1/latest';

export const newsdataProvider = {
  name: 'newsdata',

  enabled() {
    return !!process.env.NEWSDATA_API_KEY;
  },

  async fetch({ limit = 10, categories, country, language = 'en' } = {}) {
    const key = process.env.NEWSDATA_API_KEY;
    if (!key) return [];

    const timeframe = process.env.NEWS_TIMEFRAME; // e.g. "6" (hours) or "48m"

    const collected = [];
    let page = null;
    const maxPages = Math.min(20, Math.ceil(limit / 10));

    for (let i = 0; i < maxPages && collected.length < limit; i++) {
      const params = new URLSearchParams({ apikey: key, language });
      if (categories) params.set('category', categories); // comma-separated
      if (country) params.set('country', country);        // e.g. "in"
      if (timeframe) params.set('timeframe', timeframe);   // recency window
      if (page) params.set('page', page);

      let json;
      try {
        const res = await fetch(`${BASE}?${params.toString()}`);
        json = await res.json();
      } catch (e) {
        console.error('[news:newsdata] fetch error', e.message);
        break;
      }
      if (json.status !== 'success' || !Array.isArray(json.results)) {
        // NewsData puts error details under results.message on failures.
        const msg = json.results?.message || json.message || json.status;
        console.error('[news:newsdata] bad response:', msg);
        break;
      }

      for (const r of json.results) {
        const article = normalizeArticle({
          externalId: r.article_id,
          title: r.title,
          description: r.description || r.content?.slice(0, 300) || '',
          url: r.link,
          imageUrl: r.image_url,
          source: r.source_id,
          category: Array.isArray(r.category) ? r.category[0] : r.category,
          publishedAt: r.pubDate,
          language: r.language,
        });
        if (article) collected.push(article);
        if (collected.length >= limit) break;
      }

      page = json.nextPage;
      if (!page) break;
    }

    return collected.slice(0, limit);
  },
};