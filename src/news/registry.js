/**
 * Provider registry — the ONE place that knows all news sources.
 * Add a source: import it + add to PROVIDERS. Switch via NEWS_PROVIDER env.
 */
import { newsdataProvider } from './providers/newsdata.js';
import { rssProvider } from './providers/rss.js';

const PROVIDERS = [newsdataProvider, rssProvider];

export function listProviders() {
  return PROVIDERS.map((p) => ({ name: p.name, enabled: p.enabled() }));
}

export function getActiveProvider() {
  const forced = process.env.NEWS_PROVIDER;
  if (forced) {
    const p = PROVIDERS.find((x) => x.name === forced);
    if (p && p.enabled()) return p;
    console.error(`[news] NEWS_PROVIDER="${forced}" not found or not enabled`);
    return null;
  }
  return PROVIDERS.find((p) => p.enabled()) || null;
}