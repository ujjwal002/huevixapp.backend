/**
 * Summarize a raw news article into an exam-oriented CURRENT-AFFAIRS card.
 *
 * COPYRIGHT: we NEVER republish the source's text. We take only the headline +
 * short description and rewrite a fresh summary in our own words, plus extract
 * 3-5 memorizable "keyPoints" (exam pointers) and a glossary of key terms
 * (abbreviations / organisations / schemes — reuses the vocab tables so the
 * existing glossary UI works untouched). If the AI is unavailable, we fall
 * back to a trimmed description with no keyPoints/vocab.
 */
import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';
import { CA_CATEGORIES } from './categories.js';

const SUMMARY_TIMEOUT_MS = Number(process.env.NEWS_SUMMARY_TIMEOUT_MS) || 45000;

function fallbackSummary(article) {
  const text = (article.description || article.title || '').replace(/\s+/g, ' ').trim();
  const cut = text.length > 300 ? text.slice(0, 300).replace(/\s+\S*$/, '') + '…' : text;
  return { title: article.title.slice(0, 90), body: cut, topic: null, keyPoints: [], vocab: [] };
}

function buildPrompt(article) {
  return `Turn this news item into an exam-oriented current-affairs card for Indian competitive exams (UPSC, SSC, Banking, Railways, state PCS). Write everything in your OWN words — do NOT copy the source text.

Headline: ${article.title}
Details: ${article.description || '(none)'}
Source: ${article.source || 'unknown'}

Rules:
- "title": factual headline, max 12 words, no clickbait.
- "body": 55-75 words, neutral and factual — who/what/when/where and why it matters. Plain language, no opinion, no "click here".
- "topic": exactly ONE of: ${CA_CATEGORIES.join(', ')}. Pick the best fit.
- "keyPoints": 3-5 short, memorizable exam facts from this story (names, numbers, dates, places, ranks). Each under 15 words — the pointers an aspirant would note down.
- "vocab": 3-6 key terms that appear in the story — abbreviations, organisations, schemes, indexes or technical terms an aspirant should know. For each:
    - "term": the term as written (e.g. "NITI Aayog", "FDI", "PM-KISAN")
    - "partOfSpeech": one of "abbreviation", "organisation", "scheme", "index", "term"
    - "meaning": one simple line explaining what it is
    - "example": the full form or one line of context (may be empty)
- Base everything ONLY on the given headline/details. Do not invent facts, numbers or dates.

Return STRICT JSON only, no markdown:
{ "title": "string", "body": "string", "topic": "string", "keyPoints": ["string"], "vocab": [ { "term": "string", "partOfSpeech": "string", "meaning": "string", "example": "string" } ] }`;
}

function cleanKeyPoints(points) {
  if (!Array.isArray(points)) return [];
  const out = [];
  const seen = new Set();
  for (const p of points) {
    if (typeof p !== 'string') continue;
    const s = p
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[-•*]\s*/, '');
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s.slice(0, 160));
    if (out.length >= 5) break;
  }
  return out;
}

function cleanVocab(vocab) {
  if (!Array.isArray(vocab)) return [];
  const out = [];
  const seen = new Set();
  for (const v of vocab) {
    if (!v || typeof v.term !== 'string' || !v.term.trim()) continue;
    if (typeof v.meaning !== 'string' || !v.meaning.trim()) continue;
    const key = v.term.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      term: v.term.trim(),
      partOfSpeech: typeof v.partOfSpeech === 'string' && v.partOfSpeech.trim() ? v.partOfSpeech.trim() : 'term',
      meaning: v.meaning.trim(),
      example: typeof v.example === 'string' ? v.example.trim() : '',
    });
    if (out.length >= 6) break;
  }
  return out;
}

export async function summarizeArticle(article) {
  if (config.mockExternal || !config.ai.apiKey) return fallbackSummary(article);

  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: config.ai.apiKey,
      timeout: SUMMARY_TIMEOUT_MS,
      maxRetries: 1,
    });
    const completion = await withTimeout(
      client.chat.completions.create({
        model: config.ai.model,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          {
            role: 'system',
            content:
              'You are an editor for a daily current-affairs app used by Indian competitive-exam aspirants. Be factual and neutral, rewrite in your own words, and reply with strict JSON only.',
          },
          { role: 'user', content: buildPrompt(article) },
        ],
      }),
      { label: 'news summary', ms: SUMMARY_TIMEOUT_MS }
    );
    const txt = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
    } catch {
      parsed = null;
    }
    if (parsed?.title && parsed?.body) {
      return {
        title: String(parsed.title).trim().slice(0, 120),
        body: String(parsed.body).trim(),
        topic: typeof parsed.topic === 'string' ? parsed.topic.trim() : null,
        keyPoints: cleanKeyPoints(parsed.keyPoints),
        vocab: cleanVocab(parsed.vocab),
      };
    }
    return fallbackSummary(article);
  } catch (e) {
    console.error('[news:summarize] failed, using fallback:', e.message);
    return fallbackSummary(article);
  }
}