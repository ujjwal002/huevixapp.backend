import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';

// =============================================================================
// Daily vocabulary generation (10 words/day + a fill-in-the-blank question each).
//
// Mirrors quizAi.service.js: honours config.mockExternal so the flow runs with
// no API key, and ALWAYS returns a valid set — malformed model output falls back
// to a deterministic mock so the daily vocab is never empty.
//
// The caller passes `avoidWords` (words used on previous days) so the model
// doesn't repeat — this is the "AI remembers what it created before" part.
//
// Each item is:
//   {
//     word, partOfSpeech, meaning, example,   // the LEARN card
//     question: {                              // the PRACTICE question
//       sentence: "... ___ ...",  // the word blanked out with ___
//       options: [w, d1, d2, d3], // 4 options, one is `word`
//       correctIndex: 0..3,
//     }
//   }
//
// SECURITY: items include question.correctIndex. The CALLER stores it and must
// NEVER send it to the client before the user answers.
// =============================================================================

const WORD_COUNT = 10;

function mockVocab() {
  const base = [
    { word: 'meticulous', partOfSpeech: 'adjective', meaning: 'showing great attention to detail; very careful', example: 'She was meticulous about checking every figure in the report.' },
    { word: 'resilient', partOfSpeech: 'adjective', meaning: 'able to recover quickly from difficulties', example: 'The community proved resilient after the floods.' },
    { word: 'candid', partOfSpeech: 'adjective', meaning: 'honest and straightforward', example: 'He gave a candid account of what went wrong.' },
    { word: 'alleviate', partOfSpeech: 'verb', meaning: 'to make suffering or a problem less severe', example: 'The new medicine helped alleviate her pain.' },
    { word: 'inevitable', partOfSpeech: 'adjective', meaning: 'certain to happen; unavoidable', example: 'With no rain for months, a drought seemed inevitable.' },
    { word: 'pragmatic', partOfSpeech: 'adjective', meaning: 'dealing with things sensibly and realistically', example: 'They took a pragmatic approach to the budget.' },
    { word: 'diligent', partOfSpeech: 'adjective', meaning: 'hard-working and careful', example: 'A diligent student, she never missed a deadline.' },
    { word: 'ambiguous', partOfSpeech: 'adjective', meaning: 'open to more than one interpretation; unclear', example: 'His ambiguous reply left everyone confused.' },
    { word: 'prudent', partOfSpeech: 'adjective', meaning: 'acting with care and thought for the future', example: 'It is prudent to save some money each month.' },
    { word: 'tenacious', partOfSpeech: 'adjective', meaning: 'holding firmly to a purpose; persistent', example: 'Her tenacious effort finally paid off.' },
  ];
  const words = base.map((b) => b.word);
  return base.map((b, i) => ({
    ...b,
    question: {
      sentence: b.example.replace(new RegExp(b.word, 'i'), '___'),
      options: buildOptions(b.word, words, i),
      correctIndex: 0, // fixed up below
    },
  })).map((item) => {
    const idx = item.question.options.indexOf(item.word);
    return { ...item, question: { ...item.question, correctIndex: idx < 0 ? 0 : idx } };
  });
}

// Build 4 options for a word: the word itself + 3 distractors from the set.
function buildOptions(word, allWords, seed) {
  const others = allWords.filter((w) => w !== word);
  const picks = [];
  for (let k = 0; k < others.length && picks.length < 3; k++) {
    picks.push(others[(seed + k) % others.length]);
  }
  const uniq = [...new Set(picks)].slice(0, 3);
  const opts = [word, ...uniq];
  const rot = seed % opts.length;
  return opts.slice(rot).concat(opts.slice(0, rot));
}

// Strictly validate model output. Returns a clean array or null.
function validate(items) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const cleaned = [];
  const seen = new Set();
  for (const it of items) {
    if (!it || typeof it.word !== 'string' || !it.word.trim()) continue;
    const word = it.word.trim();
    const key = word.toLowerCase();
    if (seen.has(key)) continue; // no dupes within the set
    if (typeof it.meaning !== 'string' || !it.meaning.trim()) continue;
    if (typeof it.example !== 'string' || !it.example.trim()) continue;
    const q = it.question;
    if (!q || typeof q.sentence !== 'string' || !q.sentence.includes('___')) continue;
    if (!Array.isArray(q.options) || q.options.length !== 4) continue;
    if (q.options.some((o) => typeof o !== 'string' || !o.trim())) continue;
    const ci = q.correctIndex;
    if (!Number.isInteger(ci) || ci < 0 || ci > 3) continue;
    if (q.options[ci].trim().toLowerCase() !== key) {
      const found = q.options.findIndex((o) => o.trim().toLowerCase() === key);
      if (found < 0) continue;
      q.correctIndex = found;
    }
    seen.add(key);
    cleaned.push({
      word,
      partOfSpeech: typeof it.partOfSpeech === 'string' ? it.partOfSpeech.trim() : null,
      meaning: it.meaning.trim(),
      example: it.example.trim(),
      question: {
        sentence: q.sentence.trim(),
        options: q.options.map((o) => o.trim()),
        correctIndex: q.correctIndex,
      },
    });
  }
  return cleaned.length ? cleaned : null;
}

function buildPrompt(avoidWords) {
  const avoid = (avoidWords || []).slice(0, 400); // cap prompt size
  const avoidLine =
    avoid.length > 0
      ? `\nDo NOT use any of these already-used words (pick different ones):\n${avoid.join(', ')}`
      : '';
  return `Generate ${WORD_COUNT} useful English vocabulary words for a daily vocab-learning app aimed at intermediate learners.
For EACH word provide:
- "word": the word (single word, lowercase)
- "partOfSpeech": e.g. noun, verb, adjective, adverb
- "meaning": a short, clear definition (learner-friendly)
- "example": ONE natural sentence that uses the word correctly, showing how it is used
- "question": a fill-in-the-blank practice item:
    - "sentence": a NEW sentence (different from example) with the target word replaced by exactly "___"
    - "options": EXACTLY 4 single-word options; one MUST be the target word, the other 3 are plausible but wrong in that sentence
    - "correctIndex": 0-based index (0-3) of the target word in options

Choose commonly useful words (not obscure). Vary parts of speech.${avoidLine}

Return STRICT JSON only, no markdown:
{
  "items": [
    {
      "word": "meticulous",
      "partOfSpeech": "adjective",
      "meaning": "showing great attention to detail",
      "example": "She was meticulous about every detail of the plan.",
      "question": { "sentence": "He kept ___ notes on every experiment.", "options": ["meticulous","enormous","cheerful","ancient"], "correctIndex": 0 }
    }
  ]
}`;
}

export async function generateDailyVocab({ avoidWords = [] } = {}) {
  if (config.mockExternal || !config.ai.apiKey) return mockVocab();
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({
      apiKey: config.ai.apiKey,
      timeout: config.externalTimeoutMs,
      maxRetries: 2,
    });
    const completion = await withTimeout(
      client.chat.completions.create({
        model: config.ai.model,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a vocabulary teacher. Reply with strict JSON only, no markdown.' },
          { role: 'user', content: buildPrompt(avoidWords) },
        ],
      }),
      { label: 'vocab generation' }
    );
    const txt = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
    } catch {
      parsed = null;
    }
    const items = parsed?.items || parsed?.words || parsed;
    return validate(items) || mockVocab();
  } catch (err) {
    console.error('[vocabAi] generation failed, using fallback:', err.message);
    return mockVocab();
  }
}

export const DAILY_VOCAB_WORD_COUNT = WORD_COUNT;