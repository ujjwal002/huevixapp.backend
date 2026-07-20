/**
 * Current-affairs categories — the ONE place that defines the exam-oriented
 * category set. Cards store one of these in Card.topic, the AI summarizer is
 * asked to pick from this list, and the app builds its category tabs from
 * GET /cards/topics.
 *
 * Keep the slugs short, lowercase and URL-safe: they travel in query strings
 * (GET /cards/feed?topic=polity).
 */
export const CA_CATEGORIES = [
  'polity', // constitution, SC/HC judgments, parliament, governance
  'economy', // RBI, budget, GDP, banking, trade, indexes
  'international', // bilateral ties, summits, global orgs (UN, BRICS, G20)
  'science-tech', // ISRO, AI, space, research, IT policy
  'defence', // exercises, procurement, armed forces, border security
  'environment', // climate, biodiversity, pollution, disasters
  'sports', // tournaments, medals, records
  'awards', // awards, honours, appointments, persons in news
  'schemes', // government schemes, missions, portals, yojanas
  'national', // everything else India-specific (fallback)
];

export const DEFAULT_CATEGORY = 'national';

// Map raw source categories (NewsData.io etc.) + common AI variants onto our
// canonical set. Unknown values fall through to DEFAULT_CATEGORY.
const ALIASES = {
  politics: 'polity',
  polity: 'polity',
  governance: 'polity',
  law: 'polity',
  judiciary: 'polity',
  business: 'economy',
  economy: 'economy',
  finance: 'economy',
  markets: 'economy',
  banking: 'economy',
  world: 'international',
  international: 'international',
  'international relations': 'international',
  diplomacy: 'international',
  science: 'science-tech',
  technology: 'science-tech',
  tech: 'science-tech',
  'science-tech': 'science-tech',
  'science & technology': 'science-tech',
  space: 'science-tech',
  defence: 'defence',
  defense: 'defence',
  military: 'defence',
  security: 'defence',
  environment: 'environment',
  climate: 'environment',
  weather: 'environment',
  sports: 'sports',
  sport: 'sports',
  awards: 'awards',
  award: 'awards',
  appointments: 'awards',
  persons: 'awards',
  obituary: 'awards',
  schemes: 'schemes',
  scheme: 'schemes',
  yojana: 'schemes',
  mission: 'schemes',
  top: 'national',
  domestic: 'national',
  national: 'national',
  india: 'national',
  education: 'national',
  health: 'national',
};

export function normalizeCategory(raw) {
  if (!raw || typeof raw !== 'string') return DEFAULT_CATEGORY;
  const key = raw.trim().toLowerCase();
  if (CA_CATEGORIES.includes(key)) return key;
  return ALIASES[key] || DEFAULT_CATEGORY;
}