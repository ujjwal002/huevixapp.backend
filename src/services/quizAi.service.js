import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';

// =============================================================================
// Daily quiz question generation (20 questions/day).
//
// Honours config.mockExternal so the whole flow runs locally with zero API
// keys, and ALWAYS returns valid questions — if the model returns malformed
// data we fall back to the deterministic mock so the daily quiz is never empty.
//
// SECURITY: returned objects include correctIndex. The CALLER stores it in the
// DB and must NEVER send it to the client before the user answers.
//
// To change the quiz topic (e.g. SSC GK, English, science), edit PROMPT below.
// =============================================================================

const TOTAL = 20;

// Generating 20 structured questions is a HEAVY generation and legitimately
// takes longer than a normal API call. This runs in a background cron (or a
// lazy first-open), so a generous timeout is fine — the 25s global default was
// firing mid-generation and silently falling back to the static mock every day.
const QUIZ_GEN_TIMEOUT_MS = 90_000;

// gpt-4o-mini often returns a couple fewer than asked, so we request a BUFFER
// (see PROMPT) and accept any batch with at least MIN_ACCEPTABLE valid
// questions instead of demanding exactly TOTAL. Falling back to the static mock
// only when we truly can't get enough was the bug that froze the daily quiz.
const REQUEST_COUNT = 24; // ask for extra so >= 20 reliably survive validation
const MIN_ACCEPTABLE = 15; // serve real questions if we got at least this many

function mockQuestions() {
  // 20 general-knowledge questions with clear, unambiguous answers.
  return [
    { prompt: 'What is the capital of India?', options: ['Mumbai', 'New Delhi', 'Kolkata', 'Chennai'], correctIndex: 1, explanation: 'New Delhi is the capital of India.' },
    { prompt: 'How many continents are there on Earth?', options: ['5', '6', '7', '8'], correctIndex: 2, explanation: 'There are 7 continents.' },
    { prompt: 'Which is the largest planet in our solar system?', options: ['Earth', 'Jupiter', 'Saturn', 'Mars'], correctIndex: 1, explanation: 'Jupiter is the largest planet.' },
    { prompt: 'What is the national animal of India?', options: ['Lion', 'Tiger', 'Elephant', 'Peacock'], correctIndex: 1, explanation: 'The Royal Bengal Tiger is the national animal.' },
    { prompt: 'Who wrote the national anthem of India?', options: ['Mahatma Gandhi', 'Rabindranath Tagore', 'Jawaharlal Nehru', 'Subhas Chandra Bose'], correctIndex: 1, explanation: 'Rabindranath Tagore wrote "Jana Gana Mana".' },
    { prompt: 'What is the chemical symbol for water?', options: ['CO2', 'H2O', 'O2', 'NaCl'], correctIndex: 1, explanation: 'Water is H2O.' },
    { prompt: 'Which is the largest ocean on Earth?', options: ['Atlantic', 'Indian', 'Pacific', 'Arctic'], correctIndex: 2, explanation: 'The Pacific Ocean is the largest.' },
    { prompt: 'How many players are there in a cricket team?', options: ['9', '10', '11', '12'], correctIndex: 2, explanation: 'A cricket team has 11 players.' },
    { prompt: 'What is the smallest prime number?', options: ['0', '1', '2', '3'], correctIndex: 2, explanation: '2 is the smallest prime number.' },
    { prompt: 'What is the currency of Japan?', options: ['Yuan', 'Yen', 'Won', 'Dollar'], correctIndex: 1, explanation: 'The Japanese currency is the Yen.' },
    { prompt: 'Which gas do plants absorb from the air?', options: ['Oxygen', 'Carbon dioxide', 'Nitrogen', 'Hydrogen'], correctIndex: 1, explanation: 'Plants absorb carbon dioxide for photosynthesis.' },
    { prompt: 'How many days are there in a leap year?', options: ['365', '366', '364', '367'], correctIndex: 1, explanation: 'A leap year has 366 days.' },
    { prompt: 'The speed of light is approximately?', options: ['3,000 km/s', '30,000 km/s', '3,00,000 km/s', '30,00,000 km/s'], correctIndex: 2, explanation: 'Light travels about 3,00,000 km/s.' },
    { prompt: 'The Taj Mahal is located in which city?', options: ['Delhi', 'Agra', 'Jaipur', 'Lucknow'], correctIndex: 1, explanation: 'The Taj Mahal is in Agra.' },
    { prompt: 'Which is the smallest continent?', options: ['Asia', 'Europe', 'Australia', 'Antarctica'], correctIndex: 2, explanation: 'Australia is the smallest continent.' },
    { prompt: 'Who was the first person to walk on the moon?', options: ['Yuri Gagarin', 'Neil Armstrong', 'Buzz Aldrin', 'John Glenn'], correctIndex: 1, explanation: 'Neil Armstrong was first, in 1969.' },
    { prompt: 'How many bones are there in the adult human body?', options: ['206', '201', '210', '200'], correctIndex: 0, explanation: 'An adult human has 206 bones.' },
    { prompt: 'Which planet is known as the Red Planet?', options: ['Venus', 'Mars', 'Jupiter', 'Mercury'], correctIndex: 1, explanation: 'Mars is called the Red Planet.' },
    { prompt: 'How many colours are there in a rainbow?', options: ['5', '6', '7', '8'], correctIndex: 2, explanation: 'A rainbow has 7 colours (VIBGYOR).' },
    { prompt: 'Which is the largest mammal in the world?', options: ['Elephant', 'Blue whale', 'Giraffe', 'Hippopotamus'], correctIndex: 1, explanation: 'The blue whale is the largest mammal.' },
  ].slice(0, TOTAL);
}

// Strictly validate model output. Returns a clean array or null.
// Validate model output. Returns a cleaned array of the VALID questions (bad
// ones are dropped, not fatal), or null only if too few survived to be worth
// serving. Caller trims to the final count.
function validate(items) {
  if (!Array.isArray(items)) return null;
  const cleaned = [];
  for (const q of items) {
    if (!q || typeof q.prompt !== 'string' || !q.prompt.trim()) continue;
    if (!Array.isArray(q.options) || q.options.length !== 4) continue;
    if (!q.options.every((o) => typeof o === 'string' && o.trim())) continue;
    const ci = Number(q.correctIndex);
    if (!Number.isInteger(ci) || ci < 0 || ci > 3) continue;
    cleaned.push({
      prompt: q.prompt.trim(),
      options: q.options.map((o) => String(o).trim()),
      correctIndex: ci,
      explanation: typeof q.explanation === 'string' ? q.explanation.trim() : null,
    });
  }
  return cleaned.length >= MIN_ACCEPTABLE ? cleaned : null;
}

// EDIT THIS to change the quiz subject.
const PROMPT = `Generate ${REQUEST_COUNT} multiple-choice quiz questions for a daily general-knowledge quiz app.
Mix general knowledge, basic science, simple math/reasoning, geography, and history. Easy to medium difficulty.
Each question must have EXACTLY 4 options and exactly one correct answer.

Return STRICT JSON only, no markdown:
{
  "questions": [
    { "prompt": "the question", "options": ["A","B","C","D"], "correctIndex": 0, "explanation": "one short sentence" }
  ]
}
Make wrong options plausible. correctIndex is 0-based (0-3).`;

export async function generateQuizQuestions(_opts = {}) {
  if (config.mockExternal || !config.ai.apiKey) return mockQuestions();
  try {
    const { default: OpenAI } = await import('openai');
    const client = new OpenAI({ apiKey: config.ai.apiKey, timeout: QUIZ_GEN_TIMEOUT_MS, maxRetries: 2 });
    const completion = await withTimeout(
      client.chat.completions.create({
        model: config.ai.model,
        max_tokens: 4096,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You write quiz questions. Reply with strict JSON only, no markdown.' },
          { role: 'user', content: PROMPT },
        ],
      }),
      { label: 'quiz generation', ms: QUIZ_GEN_TIMEOUT_MS }
    );
    const txt = completion.choices?.[0]?.message?.content || '{}';
    let parsed;
    try {
      parsed = JSON.parse(txt.replace(/```json|```/g, '').trim());
    } catch {
      parsed = null;
    }
    const items = parsed?.questions || parsed?.items || parsed;
    return validate(items) || mockQuestions();
  } catch (err) {
    console.error('[quizAi] generation failed, using fallback:', err.message);
    return mockQuestions();
  }
}

export const QUIZ_QUESTION_COUNT = TOTAL;