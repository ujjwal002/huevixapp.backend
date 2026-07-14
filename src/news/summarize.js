/**
 * Summarize a raw news article into our OWN short card + a vocab glossary.
 *
 * COPYRIGHT: we NEVER republish the source's text. We take only the headline +
 * short description and rewrite a fresh ~60-word summary in our own words, plus
 * extract a few complex words with learner-friendly meanings (the vocab feature).
 * If the AI is unavailable, we fall back to a trimmed description and no vocab.
 */
import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';

const SUMMARY_TIMEOUT_MS = Number(process.env.NEWS_SUMMARY_TIMEOUT_MS) || 45000;

function fallbackSummary(article) {
    const text = (article.description || article.title || '').replace(/\s+/g, ' ').trim();
    const cut = text.length > 300 ? text.slice(0, 300).replace(/\s+\S*$/, '') + '…' : text;
    return { title: article.title.slice(0, 90), body: cut, vocab: [] };
}

function buildPrompt(article, nativeLanguage) {
    return `Rewrite this news into a short, simple summary in your OWN words (do NOT copy the original text), and extract the words a BEGINNER English learner would find hard.

Headline: ${article.title}
Details: ${article.description || '(none)'}
Source: ${article.source || 'unknown'}

Rules:
- "title": a clear, simple headline, max 12 words.
- "body": 50-70 words, simple and easy to read, in your own words. Use plain language a beginner can follow. No opinion, no "click here".
- "vocab": Pick the words in your body that a BEGINNER English learner would NOT know yet (aim for 5-8 words). For beginners, this includes intermediate everyday words like "scrutiny", "discrepancy", "hospitality", "commend", "respond", "attend", "reception", "protest" — not just rare words. Skip only the very basic words (the, is, and, go, day, new). For each word:
    - "term": the word (as it appears)
    - "partOfSpeech": noun/verb/adjective/adverb/etc.
    - "meaning": a very simple, beginner-friendly definition (use easy words)
    - "example": a short, simple example sentence using the word
- Do not invent facts beyond what's given.

Return STRICT JSON only, no markdown:
{ "title": "string", "body": "string", "vocab": [ { "term": "string", "partOfSpeech": "string", "meaning": "string", "example": "string" } ] }`;
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
            partOfSpeech: typeof v.partOfSpeech === 'string' ? v.partOfSpeech.trim() : 'word',
            meaning: v.meaning.trim(),
            example: typeof v.example === 'string' ? v.example.trim() : '',
        });
        if (out.length >= 6) break;
    }
    return out;
}

export async function summarizeArticle(article, nativeLanguage = 'en') {
    if (config.mockExternal || !config.ai.apiKey) return fallbackSummary(article);

    try {
        const { default: OpenAI } = await import('openai');
        const client = new OpenAI({ apiKey: config.ai.apiKey, timeout: SUMMARY_TIMEOUT_MS, maxRetries: 1 });
        const completion = await withTimeout(
            client.chat.completions.create({
                model: config.ai.model,
                max_tokens: 700,
                response_format: { type: 'json_object' },
                messages: [
                    { role: 'system', content: 'You are a news editor and language teacher. Rewrite in your own words. Reply with strict JSON only.' },
                    { role: 'user', content: buildPrompt(article, nativeLanguage) },
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
                vocab: cleanVocab(parsed.vocab),
            };
        }
        return fallbackSummary(article);
    } catch (e) {
        console.error('[news:summarize] failed, using fallback:', e.message);
        return fallbackSummary(article);
    }
}