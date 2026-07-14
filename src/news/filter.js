/**
 * Content filter for news — FULLY controlled by env so you can switch it on/off
 * without code changes.
 *
 *   NEWS_FILTER=off     (default) publish everything the source returns
 *   NEWS_FILTER=on      apply the blocklist below
 *   NEWS_BLOCK_EXTRA    comma-separated extra terms to block (used when on)
 *
 * NOTE: even with the filter OFF, you should be aware that Google Play and
 * AdMob prohibit content that sexualizes or endangers minors. Publishing such
 * content can get the app removed. Turn the filter ON (at least) before you
 * submit to the Play Store.
 */
const BLOCK_TERMS = [
  // sexual crimes
  'rape', 'raped', 'raping', 'molest', 'molested', 'molestation',
  'sexual assault', 'sexually assaulted', 'gang rape', 'gangrape',
  'pedophile', 'paedophile', 'child abuse', 'sexual abuse',
  // harm to minors
  'minor girl', 'minor boy', 'schoolgirl', 'schoolgirls', 'schoolboy',
  'missing girl', 'missing boy', 'missing child', 'missing children',
  'missing student', 'missing students', 'abduct', 'abducted', 'abduction',
  'kidnap', 'kidnapped', 'kidnapping', 'trafficking', 'trafficked',
  'child marriage', 'minor married',
  // graphic violence / gore
  'mutilated', 'mutilation', 'dismember', 'beheaded', 'decapitat',
  'gruesome', 'gory', 'gore', 'brutally', 'tortured', 'torture',
  'corpse', 'body found', 'bodies found', 'hacked to death',
  // individual tragedy
  'suicide', 'self-immolation', 'hangs self', 'hanged self',
  'stabbed to death', 'burnt alive', 'set on fire',
  'murder', 'murdered', 'raped and killed', 'found dead',
];

function terms() {
  const extra = (process.env.NEWS_BLOCK_EXTRA || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...BLOCK_TERMS, ...extra];
}

// true = SAFE to publish. When NEWS_FILTER is not "on", everything passes.
export function isAppropriate(article) {
  if ((process.env.NEWS_FILTER || 'off').toLowerCase() !== 'on') {
    return true; // filter disabled — publish everything
  }
  const hay = `${article.title || ''} ${article.description || ''}`.toLowerCase();
  for (const t of terms()) {
    const re = new RegExp(`(^|[^a-z])${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`, 'i');
    if (re.test(hay)) return false;
  }
  return true;
}