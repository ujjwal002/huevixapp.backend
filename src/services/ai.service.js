import { config, languageMeta, SUPPORTED_NATIVE_LANGUAGES } from '../config/env.js';

// Generates an Inshorts-style short card (title + ~80-word body) in the target
// language, plus a glossary of complex words with meanings in the native
// language. In mock mode this returns deterministic sample data so the whole
// pipeline runs with zero API keys.

const MOCK_CARDS = {
  en: {
    interview: {
      title: 'Nailing the First Impression',
      body:
        'In a job interview, the first few minutes are crucial. Recruiters often form an impression before you even sit down. Maintain steady eye contact, offer a firm handshake, and articulate your strengths with concrete examples. Avoid vague statements; instead, quantify your achievements. Preparation conveys confidence, and confidence is contagious. When you demonstrate genuine enthusiasm for the role, you become memorable for the right reasons.',
      vocab: [
        { term: 'crucial', partOfSpeech: 'adjective', meaning: 'extremely important', example: 'These minutes are crucial.' },
        { term: 'articulate', partOfSpeech: 'verb', meaning: 'to express clearly', example: 'Articulate your strengths.' },
        { term: 'quantify', partOfSpeech: 'verb', meaning: 'to measure with numbers', example: 'Quantify your achievements.' },
        { term: 'contagious', partOfSpeech: 'adjective', meaning: 'easily spreading to others', example: 'Confidence is contagious.' },
      ],
    },
  },
};

function buildPrompt({ targetLanguage, nativeLanguage, level, topic }) {
  const target = languageMeta(targetLanguage)?.name || targetLanguage;
  const native = SUPPORTED_NATIVE_LANGUAGES[nativeLanguage] || nativeLanguage;
  return `You are a language-learning content writer. Write ONE short, engaging,
Inshorts-style card to teach ${target} at ${level} level${topic ? ` about "${topic}"` : ''}.

Return STRICT JSON only, no markdown, with this shape:
{
  "title": "string (max 8 words)",
  "body": "string (60-110 words, natural and interesting, not a drill)",
  "vocab": [
    { "term": "complex word from the body",
      "partOfSpeech": "noun|verb|adjective|adverb|...",
      "meaning": "meaning written in ${native}",
      "example": "short example sentence in ${target}" }
  ]
}
Pick 3-6 genuinely tricky words for the vocab list. Meanings MUST be in ${native}.`;
}

export async function generateCard({ targetLanguage, nativeLanguage, level, topic }) {
  if (config.mockExternal || !config.ai.apiKey) {
    const sample =
      MOCK_CARDS[targetLanguage]?.[topic] ||
      MOCK_CARDS[targetLanguage]?.interview ||
      MOCK_CARDS.en.interview;
    return {
      title: sample.title,
      body: sample.body,
      vocab: sample.vocab,
      _mock: true,
    };
  }

  // --- Real provider call (OpenAI) ---
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.ai.apiKey });
  const completion = await client.chat.completions.create({
    model: config.ai.model,
    max_tokens: 1200,
    // Forces a valid JSON object back (prompt must mention JSON, which it does).
    response_format: { type: 'json_object' },
    messages: [
      {
        role: 'system',
        content: 'You are a language-learning content writer. Reply with strict JSON only, no markdown.',
      },
      { role: 'user', content: buildPrompt({ targetLanguage, nativeLanguage, level, topic }) },
    ],
  });
  const text = completion.choices?.[0]?.message?.content || '{}';
  const clean = text.replace(/```json|```/g, '').trim();
  const parsed = JSON.parse(clean);
  return { title: parsed.title, body: parsed.body, vocab: parsed.vocab || [] };
}