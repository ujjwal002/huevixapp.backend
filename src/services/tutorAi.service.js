import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';

// The strict, sarcastic Hindi vocabulary roaster ("Guruji"). Turns lesson steps
// into spoken Hindi lines and judges spoken answers. One cheap LLM call per turn
// in real mode; canned Hindi in mock mode so the whole flow runs with no key.
//
// GUARDRAILS (in the system prompt): roast the ANSWER and the EFFORT, never the
// person — no jabs at intelligence, looks, identity, or anything protected, and
// soften entirely for a child or an upset learner. Comedy, not abuse.

const SYSTEM = `You are "Guruji", a strict, sarcastic Hindi vocabulary teacher inside a language-learning app.
RULES:
- Always reply in Hindi (Devanagari). Keep replies short and punchy: 1-2 sentences.
- Persona: a theatrical sarcastic roaster. Tease wrong, lazy, or empty answers. But roast the ANSWER and the EFFORT ONLY.
- NEVER insult the person's intelligence, appearance, identity, religion, caste, gender, or anything protected. No slurs, no cruelty, nothing demeaning about who they are.
- If the learner seems to be a child or genuinely upset/discouraged, drop the sarcasm and simply encourage them.
- The vocabulary words are ENGLISH; their meanings are given in Hindi. Quote the English word as-is.`;

async function chat(messages, { json = false } = {}) {
  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({
    apiKey: config.ai.apiKey,
    timeout: config.externalTimeoutMs,
    maxRetries: 2,
  });
  const completion = await withTimeout(
    client.chat.completions.create({
      model: config.ai.model,
      max_tokens: 220,
      temperature: 0.9,
      ...(json ? { response_format: { type: 'json_object' } } : {}),
      messages: [{ role: 'system', content: SYSTEM }, ...messages],
    }),
    { label: 'vocab tutor' }
  );
  return completion.choices?.[0]?.message?.content?.trim() || '';
}

// --- mock Hindi (used in mock mode / on any LLM error) -----------------------

function mockCorrect(word, answer) {
  const a = (answer || '').toLowerCase();
  const hay = [word.word, word.meaning, word.translation]
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());
  if (hay.some((h) => h && a.includes(h))) return true;
  return Math.random() < 0.5;
}

function mockReact(word, correct, attemptsSoFar) {
  if (correct) {
    return `वाह! रुकी हुई घड़ी भी दिन में दो बार सही होती है। "${word.word}" सही है।`;
  }
  if (attemptsSoFar >= 1) {
    return `फिर गलत। "${word.word}" का मतलब है "${word.meaning}"। अब तो याद कर लो।`;
  }
  return `गलत। "${word.word}" यानी "${word.meaning}"। चलो, एक आख़िरी मौका — मतलब बताओ।`;
}

function mockLine(kind, word, stats, opts = {}) {
  switch (kind) {
    case 'greeting':
      if (opts.firstTime)
        return 'अरे, नमस्ते! कैसे हो? पहली बार आए हो — चलो आज से शुरू करते हैं। बीस नए शब्द, ध्यान से।';
      if (opts.willQuiz)
        return 'अरे, वापस आ गए! कैसे हो? चलो पहले देखते हैं पिछली बार के शब्द कितने याद हैं।';
      return 'वापस आ गए, बढ़िया! कैसे हो? चलो आगे बढ़ते हैं।';
    case 'ask':
      return `बताओ — "${word.word}" का मतलब क्या होता है? सोच-समझकर, तुक्का मत मारना।`;
    case 'teach':
      return `नया शब्द: "${word.word}" — मतलब "${word.meaning}"।${word.example ? ` जैसे: ${word.example}।` : ''} रट लो, बाद में पूछूँगा।`;
    case 'closing': {
      const c = stats?.correct ?? 0;
      const q = stats?.quizzed ?? 0;
      return q && c >= q
        ? `आज ${c}/${q} सही। चलो, थोड़ी इज़्ज़त बची रह गई। कल फिर आना।`
        : `आज ${c}/${q} सही। शर्म करो और कल बेहतर तैयारी से आना।`;
    }
    default:
      return 'आगे बढ़ते हैं।';
  }
}

// --- public API --------------------------------------------------------------

// Judge a spoken answer AND produce the roaster's reaction in one shot.
// `attemptsSoFar` lets the line phrase a first-miss reteach ("one more try")
// vs a final reveal. Returns { correct, text }.
export async function judgeAndReact({ word, answer, attemptsSoFar }) {
  if (config.mockExternal || !config.ai.apiKey) {
    const correct = mockCorrect(word, answer);
    return { correct, text: mockReact(word, correct, attemptsSoFar) };
  }

  const user = `English word: "${word.word}" (Hindi meaning: "${word.meaning}").
The learner was asked its meaning and answered (auto-transcribed, may be messy or Hinglish): "${answer || '(silence)'}".
First decide if they are ESSENTIALLY correct (don't nitpick spelling/transcription). Then give your spoken Hindi reaction.
- If WRONG and attemptsSoFar is 0 (it is ${attemptsSoFar}): scold lightly, tell them the meaning, ask ONE more time.
- If WRONG and attemptsSoFar >= 1: reveal the meaning and move on.
- If CORRECT: a grudging, sarcastic compliment.
Reply ONLY as JSON: {"correct": true|false, "text": "<your hindi line>"}.`;

  try {
    const raw = await chat([{ role: 'user', content: user }], { json: true });
    const parsed = JSON.parse(raw);
    const correct = !!parsed.correct;
    const text = String(parsed.text || '').trim();
    return { correct, text: text || mockReact(word, correct, attemptsSoFar) };
  } catch {
    const correct = mockCorrect(word, answer);
    return { correct, text: mockReact(word, correct, attemptsSoFar) };
  }
}

// A persona line for a non-judging step: greeting / ask / teach / closing.
export async function line({ kind, word, stats, firstTime, willQuiz }) {
  if (config.mockExternal || !config.ai.apiKey) {
    return { text: mockLine(kind, word, stats, { firstTime, willQuiz }) };
  }

  let greeting;
  if (firstTime) {
    greeting =
      'A NEW student just arrived. Warmly greet them in Hindi and ask how they are, then say today you will start teaching them words. 1-2 short lines, in character (strict but warm).';
  } else if (willQuiz) {
    greeting =
      'A RETURNING student arrived. Greet them in Hindi and ask how they are, then say you will first check how many of the earlier words they still remember. 1-2 short lines, in character.';
  } else {
    greeting =
      'A RETURNING student arrived. Greet them in Hindi and ask how they are, then say let us continue. 1-2 short lines, in character.';
  }

  const prompts = {
    greeting,
    ask: `Ask the student, in character, what the English word "${word?.word}" means. One line.`,
    teach: `Teach a NEW English word "${word?.word}" (meaning: "${word?.meaning}"${word?.example ? `, example: "${word.example}"` : ''}). One or two lines in character; tell them to memorise it.`,
    closing: `Wrap up today's session. They got ${stats?.correct ?? 0} of ${stats?.quizzed ?? 0} right. One line in character.`,
  };

  try {
    const text = await chat([{ role: 'user', content: prompts[kind] || prompts.greeting }]);
    return { text: text || mockLine(kind, word, stats, { firstTime, willQuiz }) };
  } catch {
    return { text: mockLine(kind, word, stats, { firstTime, willQuiz }) };
  }
}
