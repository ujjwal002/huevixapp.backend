import crypto from 'node:crypto';

// PURE half of the gov-jobs crawler: fetching, link harvesting, filtering,
// change hashing. No prisma, no app imports — unit-testable in isolation.
// The DB-touching pipeline lives in govCrawl.service.js.

export const USER_AGENT =
  'HuevixGovJobsBot/1.0 (+https://backend.huevix.com; polite notice-board watcher)';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BYTES = 3_000_000; // 3 MB cap for listing pages
const KEYWORDS =
  /(recruit|vacan|advt|advertisement|notification|notice|bharti|apply|application|employment|post[s]?\b|exam|admit|corrigendum|extension|rojgar|niyukti|appointment)/i;

// Gov sites routinely serve broken TLS (incomplete chains, expired certs —
// BPSC in production: UNABLE_TO_VERIFY_LEAF_SIGNATURE). Policy: STRICT first;
// only when the failure is a certificate-chain error do we retry that ONE
// request through a lenient dispatcher. Scoped on purpose — a process-wide
// NODE_TLS_REJECT_UNAUTHORIZED=0 would also strip verification from the
// crawler's OpenAI calls, exposing the API key. Set GOVJOBS_TLS_STRICT=1 to
// disable the lenient retry entirely.
const CERT_ERROR = /CERT|SIGNATURE|ISSUER|SELF_SIGNED|UNABLE_TO_VERIFY/i;
// Node's BUILT-IN fetch refuses a dispatcher from the npm-installed undici
// (UND_ERR_INVALID_ARG — different library copies). So the lenient path uses
// undici's own fetch together with its Agent.
let lenient;
async function getLenient() {
  if (!lenient) {
    const undici = await import('undici');
    lenient = {
      fetch: undici.fetch,
      dispatcher: new undici.Agent({ connect: { rejectUnauthorized: false } }),
    };
  }
  return lenient;
}

/** Fetch a URL with timeout, size cap, and identifying UA. */
export async function fetchText(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  const opts = {
    signal: ctrl.signal,
    redirect: 'follow',
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*' },
  };
  try {
    let res;
    try {
      res = await fetch(url, opts);
    } catch (err) {
      // undici buries the real reason (TLS cert, DNS, reset…) in err.cause;
      // surface it so GovCrawlPage.lastError is diagnosable, not "fetch failed".
      if (err.name === 'AbortError') throw new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`);
      const cause = err.cause?.code || err.cause?.message || err.message || String(err);
      const certProblem = CERT_ERROR.test(cause) && process.env.GOVJOBS_TLS_STRICT !== '1';
      if (!certProblem) throw new Error(`fetch failed: ${cause}`);
      const l = await getLenient();
      res = await l.fetch(url, { ...opts, dispatcher: l.dispatcher }).catch((e2) => {
        const c2 = e2.cause?.code || e2.cause?.message || e2.message;
        throw new Error(`fetch failed even with lenient TLS: ${c2}`);
      });
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) throw new Error(`Response too large (${buf.length} bytes)`);
    return {
      ok: res.ok,
      status: res.status,
      contentType: res.headers.get('content-type') || '',
      text: buf.toString('utf8'),
      buffer: buf,
      finalUrl: res.url || url,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Harvest <a href> links from raw HTML. A tolerant regex is deliberate here:
 * we're DISCOVERING candidate links (then keyword-filtering them), not parsing
 * the document — good enough across the wildly inconsistent gov sites without
 * dragging in a DOM library.
 * @returns {Array<{url:string, title:string}>} absolutized + deduped
 */
export function extractCandidateLinks(html, baseUrl) {
  const out = new Map();
  const re = /<a\b[^>]*?href\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const rawHref = (m[2] ?? m[3] ?? m[4] ?? '').trim();
    if (!rawHref || rawHref.startsWith('#') || /^(javascript|mailto|tel):/i.test(rawHref)) continue;
    let abs;
    try {
      abs = new URL(rawHref, baseUrl).href;
    } catch {
      continue;
    }
    const title = m[5]
      .replace(/<[^>]+>/g, ' ') // strip nested tags
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300);
    if (!out.has(abs)) out.set(abs, { url: abs, title });
  }
  return [...out.values()];
}

/** Does this link smell like a recruitment notification? */
export function looksLikeNotification({ url, title }) {
  const isPdf = /\.pdf(\?|$)/i.test(url);
  return isPdf || KEYWORDS.test(title) || KEYWORDS.test(url);
}

/** Stable hash of the candidate-link set — cheap "did anything change" check. */
export function contentHash(links) {
  const normalized = links
    .map((l) => l.url)
    .sort()
    .join('\n');
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Extract plain text from a PDF buffer using Mozilla's pdfjs (legacy build,
 * which runs in Node without a DOM). Chosen over pdf-parse: that package
 * bundles a 2018 parser that rejects many modern PDFs ("bad XRef entry"),
 * and government portals produce every PDF flavour imaginable.
 */
export async function pdfToText(buffer, { maxPages = 40 } = {}) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true })
    .promise;
  const pages = Math.min(doc.numPages, maxPages);
  let text = '';
  for (let i = 1; i <= pages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map((it) => it.str).join(' ') + '\n';
  }
  await doc.destroy();
  return text;
}

/**
 * Fallback harvester for NON-HTML listing responses — the JSON APIs that
 * SPA-style portals (SSC, RRB, RBI) load their notice boards from. Pulls
 * absolute URLs plus quoted relative paths that look like documents, so
 * pointing a source.url at the SPA's JSON endpoint needs no other changes.
 * Titles aren't recoverable from bare URLs; the filename stands in.
 */
export function extractLooseUrls(text, baseUrl) {
  const out = new Map();
  const push = (raw) => {
    let abs;
    try {
      abs = new URL(raw, baseUrl).href;
    } catch {
      return;
    }
    if (!out.has(abs)) {
      const file = decodeURIComponent(abs.split('/').pop() || '').split('?')[0];
      out.set(abs, { url: abs, title: file.replace(/[-_]+/g, ' ').trim() });
    }
  };
  const absRe = /https?:\/\/[^\s"'<>\\)\]}]+/g;
  for (const m of text.match(absRe) || []) push(m.replace(/[",']+$/, ''));
  // Quoted relative document paths, e.g. "\/uploads\/advt-01.pdf" in JSON.
  const relRe = /"((?:\\\/|\/)[^"\s<>]*?\.(?:pdf|docx?|aspx|php|html?)[^"\s<>]*)"/gi;
  let r;
  while ((r = relRe.exec(text)) !== null) push(r[1].replace(/\\\//g, '/'));
  return [...out.values()];
}