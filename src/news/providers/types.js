/**
 * News provider interface. To add a source, create a file in ./providers that
 * exports { name, enabled(), fetch(opts) } returning RawArticle[], then register
 * it in ../registry.js. Everything downstream is source-agnostic.
 */
export function normalizeArticle(a) {
  if (!a || !a.title || !a.url) return null;
  return {
    externalId: String(a.externalId || a.url),
    title: String(a.title).trim(),
    description: a.description ? String(a.description).trim() : '',
    url: String(a.url).trim(),
    imageUrl: a.imageUrl ? String(a.imageUrl).trim() : null,
    source: a.source ? String(a.source).trim() : null,
    category: a.category ? String(a.category).trim() : null,
    publishedAt: a.publishedAt || null,
    language: a.language || 'en',
  };
}