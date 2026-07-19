import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';
import { createJobSchema } from '../validators/govJobs.schemas.js';
import { fetchText, pdfToText } from './govCrawl.parse.js';
import { normalizeExtraction } from './govExtract.normalize.js';

// Turns a discovered notification link (GovCrawlItem) into a structured,
// UNVERIFIED GovJob row.
//
// Pipeline per item: fetch link → get plain text (pdf-parse for PDFs, tag-strip
// for HTML) → LLM extracts the exact createJobSchema.body shape → Zod validates
// (the same contract the admin API enforces, so the crawler can never write a
// job the engine can't evaluate) → GovJob created with verified:false.
// Nothing reaches users until an admin flips `verified` — one wrong last-date
// kills trust, so the human gate stays.

const MIN_TEXT_CHARS = 200; // shorter than this ⇒ almost certainly a scanned image PDF

/** Plain text of a notification URL (PDF or HTML). Throws with a coded reason. */
export async function fetchNotificationText(url) {
  const res = await fetchText(url);
  if (!res.ok) throw new Error(`FETCH_FAILED: HTTP ${res.status}`);

  const isPdf =
    /application\/pdf/i.test(res.contentType) || res.buffer.subarray(0, 5).toString() === '%PDF-';

  let text;
  if (isPdf) {
    text = await pdfToText(res.buffer).catch((e) => {
      throw new Error(`PDF_PARSE_FAILED: ${e.message}`);
    });
  } else {
    text = res.text
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|&amp;|&#\d+;/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  if (text.replace(/\s/g, '').length < MIN_TEXT_CHARS) {
    // Scanned-image PDFs need OCR — out of scope for v1, admin handles manually.
    throw new Error('NEEDS_OCR: no extractable text (likely a scanned PDF)');
  }
  return text.slice(0, 60_000); // plenty for any notification, bounds the LLM bill
}

function buildExtractionPrompt({ text, source }) {
  return `You extract structured data from Indian government job recruitment notifications.

SOURCE: ${source.name} (${source.shortName})${source.state ? `, state: ${source.state}` : ' (central/all-India)'}

Return STRICT JSON only (no markdown) with EXACTLY this shape. Use null when the
notification does not state a value — NEVER guess dates, fees, or age limits:
{
  "title": "string — post name + year, e.g. 'Bihar Police Constable Recruitment 2026'",
  "organization": "${source.shortName}",
  "advtNo": "string|null",
  "state": ${source.state ? `"${source.state}"` : 'null'},
  "totalVacancies": number|null,
  "applyStartDate": "YYYY-MM-DD"|null,
  "applyEndDate": "YYYY-MM-DD"|null,
  "examDate": "YYYY-MM-DD"|null,
  "eligibility": {
    "genderAllowed": "all"|"male"|"female",
    "domicile": {"mode":"none"|"required"|"reservation_only","state":"2-letter code"} | null,
    "education": {"minLevel":"TENTH"|"TWELFTH"|"ITI"|"DIPLOMA"|"GRADUATE"|"POST_GRADUATE"|null,"specific":"string|null","minPercent":number|null},
    "age": {"min":number|null,"max":number|null,"asOnDate":"YYYY-MM-DD","relaxations":[{"categories":["OBC"|"EBC"|"SC"|"ST"|"EWS"],"gender":"male"|"female"|"any","domicile":"2-letter code (omit if not domicile-gated)","extraYears":number,"additive":false}]} | null,
    "extras": [{"label":"anything else a candidate must satisfy (physical standards, attempts, language)","type":"string"}]
  },
  "feeRules": {
    "currency": "INR",
    "default": number|null,
    "rules": [{"categories":["SC","ST"],"gender":"female"|undefined,"domicile":"2-letter code if concession is domicile-gated","pwd":true|undefined,"esm":true|undefined,"amount":number}]
  }
}

Rules:
- age.asOnDate is the "as on" cutoff date printed in the notification. If none is printed, use the last date to apply. If neither exists, set "age": null.
- Fee rules are ordered most-specific-first (exemptions before concessions).
- PwD/ex-serviceman age relaxations that stack on category relaxation get "additive": true.
- If a required piece is truly absent, use null — an honest null beats a guess.
- If the document is NOT a job recruitment advertisement (result, admit card,
  answer key, merit/seniority list, syllabus, exam-date notice, etc.), return
  EXACTLY: {"not_a_job": true, "docType": "result|admit_card|answer_key|exam_notice|other", "reason": "one line"}

NOTIFICATION TEXT:
"""
${text}
"""`;
}

const MOCK_EXTRACTION = {
  title: 'Sample Clerk Recruitment 2026 (mock)',
  organization: 'MOCK',
  advtNo: 'MOCK-01/2026',
  state: null,
  totalVacancies: 100,
  applyStartDate: '2026-08-01',
  applyEndDate: '2026-08-31',
  examDate: null,
  eligibility: {
    genderAllowed: 'all',
    education: { minLevel: 'GRADUATE' },
    age: { min: 18, max: 27, asOnDate: '2026-08-01', relaxations: [] },
    extras: [],
  },
  feeRules: { currency: 'INR', default: 100, rules: [] },
};

/**
 * LLM step: notification text → createJobSchema.body-shaped object.
 * Validated with the SAME Zod schema the admin API uses; invalid output throws.
 */
export async function extractJobFromText(text, { source }) {
  let raw;
  if (config.mockExternal || !config.ai.apiKey) {
    raw = { ...MOCK_EXTRACTION, organization: source.shortName, state: source.state || null };
  } else {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: config.ai.apiKey,
      timeout: config.externalTimeoutMs,
      maxRetries: 2,
    });
    const completion = await withTimeout(
      client.chat.completions.create({
        model: config.ai.model,
        max_tokens: 2000,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are a precise data-extraction engine for Indian government job notifications. Reply with strict JSON only. Never invent values.',
          },
          { role: 'user', content: buildExtractionPrompt({ text, source }) },
        ],
      }),
      { label: 'gov-job extraction' }
    );
    const out = completion.choices?.[0]?.message?.content || '{}';
    raw = JSON.parse(out.replace(/```json|```/g, '').trim());
  }

  // Deep-normalize (recursive null prune + honesty fallbacks), then validate
  // against the same contract the admin API enforces.
  const normalized = normalizeExtraction(raw);
  if (normalized.notAJob) {
    const err = new Error(`NOT_A_JOB: ${normalized.docType} — ${normalized.reason}`);
    err.notAJob = true;
    throw err;
  }
  const parsed = createJobSchema.body.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`EXTRACTION_INVALID: ${JSON.stringify(parsed.error.flatten().fieldErrors)}`);
  }
  return parsed.data;
}

const DATE_FIELDS = ['applyStartDate', 'applyEndDate', 'examDate'];

/**
 * Full pipeline for one crawl item. Marks the item EXTRACTED (+jobId) or
 * FAILED (+error) — never throws, so a batch keeps moving.
 */
export async function processItem(item, source) {
  try {
    // Same notification already turned into a job (e.g. listed on two pages)?
    const dupe = await prisma.govJob.findFirst({ where: { notificationPdfUrl: item.url } });
    if (dupe) {
      await prisma.govCrawlItem.update({
        where: { id: item.id },
        data: { status: 'EXTRACTED', jobId: dupe.id },
      });
      return { itemId: item.id, ok: true, jobId: dupe.id, deduped: true };
    }

    const text = await fetchNotificationText(item.url);
    const body = await extractJobFromText(text, { source });

    const { sourceShortName: _ignored, ...data } = body;
    for (const f of DATE_FIELDS) {
      if (data[f] !== undefined && data[f] !== null) data[f] = new Date(data[f]);
    }

    const job = await prisma.govJob.create({
      data: {
        ...data,
        sourceId: source.id,
        requiresCet: source.requiresCet,
        officialUrl: data.officialUrl ?? source.url,
        notificationPdfUrl: item.url,
        verified: false, // the human gate
      },
    });
    await prisma.govCrawlItem.update({
      where: { id: item.id },
      data: { status: 'EXTRACTED', jobId: job.id, error: null },
    });
    return { itemId: item.id, ok: true, jobId: job.id };
  } catch (err) {
    // The LLM classifying a link as result/admit-card/etc. is a SUCCESS of the
    // pipeline, not a failure — park it as IGNORED so it never retries and
    // never clutters the admin failure list.
    const status = err.notAJob ? 'IGNORED' : 'FAILED';
    await prisma.govCrawlItem.update({
      where: { id: item.id },
      data: { status, error: String(err.message).slice(0, 500) },
    });
    return { itemId: item.id, ok: false, ignored: !!err.notAJob, error: err.message };
  }
}

/** Extract up to `limit` NEW items (oldest first), sequentially — bounds cost. */
export async function extractPending({ limit = 5 } = {}) {
  const items = await prisma.govCrawlItem.findMany({
    where: { status: 'NEW' },
    orderBy: { firstSeenAt: 'asc' },
    take: limit,
  });
  const results = [];
  for (const item of items) {
    const source = await prisma.govJobSource.findUnique({ where: { id: item.sourceId } });
    if (!source) continue;
    results.push(await processItem(item, source));
  }
  return results;
}