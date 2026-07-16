import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';
import { startOfUtcDay, isSameUtcDay } from '../utils/dates.js';
import { transcribe, synthesize, estimateSpeechSeconds } from './sarvam.service.js';
import { getOrCreateMyCode } from './referral.service.js';


// One shared OpenAI client: keeps the TLS connection warm across turns and
// avoids retry-doubling a slow call (1 retry is plenty for a voice turn).
let _openai = null;
async function getOpenAI() {
  if (!_openai) {
    const { default: OpenAI } = await import('openai');
    _openai = new OpenAI({ apiKey: config.ai.apiKey, timeout: config.externalTimeoutMs, maxRetries: 1 });
  }
  return _openai;
}

// --- Gaja conversation modes: each is a persona + difficulty + score style. ---
export const MODES = {
  general: {
    label: 'General Chat',
    greeting: "Hey! I'm Gaja. Let's just chat — what did you do today?",
    scoreLabel: 'English Score', scoreMax: 100,
    persona: 'a warm, relaxed friend making easy everyday small talk (your day, food, movies, hobbies). Keep it light and simple.',
  },
  ielts: {
    label: 'IELTS Speaking',
    greeting: "Welcome to your IELTS speaking practice. Let's begin — can you tell me about your hometown?",
    scoreLabel: 'IELTS Band', scoreMax: 9,
    persona: 'an IELTS speaking examiner. Ask Part 1/2/3-style questions one at a time, push for longer and more structured answers, and model richer vocabulary. Stay formal but encouraging.',
  },
  confidence: {
    label: 'Confidence Boost',
    greeting: "Hi! No pressure here at all — I just love hearing you talk. What's something good that happened recently?",
    scoreLabel: 'English Score', scoreMax: 100,
    persona: 'an extra-warm, low-pressure coach. Celebrate every attempt, NEVER nitpick, keep topics very easy, and build the shy learner up. Corrections should be almost invisible and always kind.',
  },
  beginner: {
    label: 'Beginner',
    greeting: "Namaste! Main Gaja hoon. Aaram se — what is your name? Aap apna naam bata sakte ho.",
    scoreLabel: 'English Score', scoreMax: 100,
    persona: 'a very patient teacher for a true beginner. Speak SLOWLY with short, basic words and short sentences. Use Hindi/Hinglish freely to help. Teach simple everyday phrases and gently repeat them.',
  },
  interview: {
    label: 'Job Interview',
    greeting: "Good to meet you. Let's start your interview practice. So — tell me a little about yourself.",
    scoreLabel: 'Interview Score', scoreMax: 10,
    persona: 'a friendly but professional job interviewer (HR). Ask common interview questions one at a time (tell me about yourself, strengths, weaknesses, why this role, a challenge you handled), with natural follow-ups. Keep a professional tone.',
  },
  business: {
    label: 'Business English',
    greeting: "Hello! Let's practice office English. Imagine we're in a quick meeting — can you give me a short update on your work?",
    scoreLabel: 'Business English', scoreMax: 100,
    persona: 'a business-English coach. Practice meetings, status updates, presenting ideas, and polite professional phrases. Model clear, confident office communication.',
  },
};

function resolveMode(m) {
  return MODES[m] ? m : 'general';
}

// SHORT, strict-JSON persona per mode: the AI talks little (cost + pedagogy) and
// returns a separate one-line correction to show under the reply.
function systemPrompt(mode) {
  const m = MODES[mode] || MODES.general;
  return [
    `You are Gaja, ${m.persona}`,
    'You are helping a Hindi-speaking learner in India practice spoken English.',
    'Rules:',
    '- Keep your spoken reply to ONE short sentence (max ~15 words) plus ONE short follow-up question.',
    '- Fix at most ONE mistake per turn, gently. If they were fine, praise briefly.',
    '- Reply in simple English; use a little Hindi/Hinglish only if the learner is stuck or speaks Hindi.',
    'Reply with STRICT JSON only: {"reply":"<spoken reply>","correction":"<one short tip, or empty string>"}',
  ].join('\n');
}

async function brain(sessionId, userText, mode) {
  if (config.mockExternal || !config.ai.apiKey) {
    return {
      reply: "That's nice! Where did you go after that?",
      correction: 'Say "I went to the market" — the past tense of "go" is "went".',
    };
  }
  // Rolling window keeps LLM cost flat instead of growing every turn.
  const history = await prisma.voiceTurn.findMany({
    where: { sessionId },
    orderBy: { createdAt: 'desc' },
    take: config.voice.historyTurns,
    select: { userText: true, aiText: true },
  });
  history.reverse();

  const messages = [{ role: 'system', content: systemPrompt(mode) }];
  for (const t of history) {
    if (t.userText) messages.push({ role: 'user', content: t.userText });
    if (t.aiText) messages.push({ role: 'assistant', content: t.aiText });
  }
  messages.push({ role: 'user', content: userText });

  const client = await getOpenAI();
  const completion = await withTimeout(
    client.chat.completions.create({
      model: config.voice.brainModel,
      max_tokens: 120,
      response_format: { type: 'json_object' },
      messages,
    }),
    { label: 'voice brain' }
  );
  let out = {};
  try { out = JSON.parse(completion.choices?.[0]?.message?.content || '{}'); } catch { out = {}; }
  return {
    reply: (out.reply || 'Nice! Tell me more.').toString().trim(),
    correction: (out.correction || '').toString().trim(),
  };
}

function freeUsedToday(user) {
  const today = startOfUtcDay();
  if (!user?.voiceFreeSecUsedDate || !isSameUtcDay(user.voiceFreeSecUsedDate, today)) return 0;
  return user.voiceFreeSecUsed || 0;
}

export async function voiceStatus(userId) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coinBalance: true, voiceFreeSecUsed: true, voiceFreeSecUsedDate: true },
  });
  const used = freeUsedToday(user);
  return {
    coinBalance: user?.coinBalance || 0,
    coinsPerSec: config.voice.coinsPerSec,
    freeDailySec: config.voice.freeDailySec,
    freeSecLeft: Math.max(0, config.voice.freeDailySec - used),
    modes: Object.entries(MODES).map(([id, m]) => ({ id, label: m.label, scoreLabel: m.scoreLabel, scoreMax: m.scoreMax })),
  };
}

export async function startSession(userId, rawMode) {
  const mode = resolveMode(rawMode);
  const session = await prisma.voiceSession.create({
    data: { userId, mode, status: 'ACTIVE' },
    select: { id: true },
  });
  const tts = await synthesize(MODES[mode].greeting); // cached after first ever call
  return { sessionId: session.id, mode, greeting: MODES[mode].greeting, audioUrl: tts?.url || null };
}

export async function endSession(userId, sessionId) {
  await prisma.voiceSession.updateMany({
    where: { id: sessionId, userId, status: 'ACTIVE' },
    data: { status: 'ENDED', endedAt: new Date() },
  });
  // Generate the shareable score card on finish (best-effort).
  const scoreCard = await scoreSession(userId, sessionId).catch(() => null);
  return { ok: true, scoreCard };
}

// Charge free-seconds first, then coins (atomic, floors at 0 like spendCoins).
async function chargeSeconds(userId, totalSec) {
  const today = startOfUtcDay();
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { coinBalance: true, voiceFreeSecUsed: true, voiceFreeSecUsedDate: true },
  });
  const usedFree = freeUsedToday(user);
  const freeAvail = Math.max(0, config.voice.freeDailySec - usedFree);
  const freeApplied = Math.min(freeAvail, totalSec);
  const paidSec = totalSec - freeApplied;
  const coins = paidSec * config.voice.coinsPerSec;

  const newFreeUsed = usedFree + freeApplied;
  await prisma.user.update({
    where: { id: userId },
    data: { voiceFreeSecUsed: newFreeUsed, voiceFreeSecUsedDate: today },
  });

  let coinsSpent = coins;
  if (coins > 0) {
    const r = await prisma.user.updateMany({
      where: { id: userId, coinBalance: { gte: coins } },
      data: { coinBalance: { decrement: coins } },
    });
    if (r.count === 0) {
      const cur = await prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
      coinsSpent = cur?.coinBalance || 0;
      await prisma.user.updateMany({ where: { id: userId, coinBalance: { gt: 0 } }, data: { coinBalance: 0 } });
    }
  }
  const after = await prisma.user.findUnique({ where: { id: userId }, select: { coinBalance: true } });
  return {
    coinsSpent,
    freeApplied,
    freeSecLeft: Math.max(0, config.voice.freeDailySec - newFreeUsed),
    coinBalance: after?.coinBalance || 0,
  };
}

export async function processTurn(userId, sessionId, audioBuffer, meta) {
  const session = await prisma.voiceSession.findFirst({
    where: { id: sessionId, userId, status: 'ACTIVE' },
    select: { id: true, mode: true },
  });
  if (!session) return { error: 'NO_SESSION' };

  const status = await voiceStatus(userId);
  if (status.freeSecLeft <= 0 && status.coinBalance <= 0) return { error: 'NEEDS_COINS' };

  const t0 = Date.now();
  const { text: userText } = await transcribe(audioBuffer, meta);
  const tStt = Date.now();
  if (!userText) {
    return { empty: true, userText: '', reply: "Sorry, I didn't catch that — try speaking again.", correction: '', audioUrl: null, coinsSpent: 0 };
  }

  const { reply, correction } = await brain(sessionId, userText, session.mode);
  const tBrain = Date.now();
  const tts = await synthesize(reply);
  const tTts = Date.now();

  const userSec = Math.min(config.voice.maxTurnSec, Math.max(1, Math.round((meta.userMs || 0) / 1000)));
  const aiSec = tts?.seconds || estimateSpeechSeconds(reply);
  const billed = await chargeSeconds(userId, userSec + aiSec);

  await prisma.voiceTurn.create({
    data: { sessionId, userText, aiText: reply, correction: correction || null, userSec, aiSec, coinsSpent: billed.coinsSpent },
  });
  await prisma.voiceSession.update({
    where: { id: sessionId },
    data: {
      turnCount: { increment: 1 },
      userAudioSec: { increment: userSec },
      aiAudioSec: { increment: aiSec },
      coinsSpent: { increment: billed.coinsSpent },
    },
  });

  console.log(
    `[voice] turn stt=${tStt - t0}ms brain=${tBrain - tStt}ms tts=${tTts - tBrain}ms ` +
    `rest=${Date.now() - tTts}ms total=${Date.now() - t0}ms cached=${tts?.cached ? 1 : 0}`
  );

  return {
    userText, reply, correction,
    audioUrl: tts?.url || null,
    coinsSpent: billed.coinsSpent,
    freeSecLeft: billed.freeSecLeft,
    coinBalance: billed.coinBalance,
    ttsCached: tts?.cached || false,
  };
}

// ----------------------- Shareable score card --------------------------------

function clampScore(v, max) {
  let n = Number(v) || 0;
  if (max === 9) n = Math.round(n * 2) / 2; // IELTS bands go in 0.5 steps
  else n = Math.round(n);
  return Math.max(0, Math.min(max, n));
}

async function withShare(userId, card) {
  const code = await getOrCreateMyCode(userId).catch(() => null);
  const shareUrl = code ? `${config.referral.shareBaseUrl}?ref=${code}` : config.referral.shareBaseUrl;
  return {
    ...card,
    shareUrl,
    shareText: `${card.shareLine}\n\nPractice English with Gaja 🦣 — join with my link: ${shareUrl}`,
  };
}

function mockCard(m) {
  const v = Math.round(m.scoreMax * 0.7 * 10) / 10;
  return {
    scoreValue: v, scoreMax: m.scoreMax, scoreLabel: m.scoreLabel,
    headline: 'Great effort today — you kept the conversation going!',
    strengths: ['You spoke in full sentences', 'Clear, confident pronunciation'],
    improvements: ['Use the past tense more often', 'Add linking words like "because" and "so"'],
    shareLine: `I scored ${v} on ${m.scoreLabel} with Gaja 🦣 — can you beat me?`,
  };
}

async function llmScore(m, turns) {
  const transcript = turns.map((t) => `Learner: ${t.userText}\nGaja: ${t.aiText}`).join('\n');
  const prompt = [
    `You are evaluating a Hindi-speaking learner's spoken English from a "${m.label}" practice session.`,
    `Give an overall score from 0 to ${m.scoreMax} (${m.scoreLabel}). Judge ONLY the learner's lines. Be encouraging but honest.`,
    'Reply with STRICT JSON only:',
    `{"scoreValue": <number 0..${m.scoreMax}>, "headline":"<one warm sentence>", "strengths":["<2-3 short points>"], "improvements":["<2-3 short, actionable points>"], "shareLine":"<one short boastable line the learner would screenshot; mention Gaja and the score>"}`,
    '',
    'Transcript:',
    transcript,
  ].join('\n');

  const { default: OpenAI } = await import('openai');
  const client = new OpenAI({ apiKey: config.ai.apiKey, timeout: config.externalTimeoutMs, maxRetries: 2 });
  const completion = await withTimeout(
    client.chat.completions.create({
      model: config.voice.brainModel,
      max_tokens: 400,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'You are a fair, encouraging English-speaking coach. Reply with strict JSON only.' },
        { role: 'user', content: prompt },
      ],
    }),
    { label: 'voice scorecard' }
  );
  let out = {};
  try { out = JSON.parse(completion.choices?.[0]?.message?.content || '{}'); } catch { out = {}; }
  return {
    scoreValue: Number(out.scoreValue) || 0,
    scoreMax: m.scoreMax, scoreLabel: m.scoreLabel,
    headline: (out.headline || 'Nice work today!').toString(),
    strengths: Array.isArray(out.strengths) ? out.strengths.slice(0, 4).map(String) : [],
    improvements: Array.isArray(out.improvements) ? out.improvements.slice(0, 4).map(String) : [],
    shareLine: (out.shareLine || 'I practiced English with Gaja 🦣').toString(),
  };
}

// Build (or return cached) score card for a session, with a referral share link.
export async function scoreSession(userId, sessionId) {
  const session = await prisma.voiceSession.findFirst({
    where: { id: sessionId, userId },
    select: {
      id: true, mode: true, scoreCard: true,
      turns: { orderBy: { createdAt: 'asc' }, select: { userText: true, aiText: true } },
    },
  });
  if (!session) return null;
  if (session.scoreCard) return withShare(userId, session.scoreCard); // already scored

  const m = MODES[session.mode] || MODES.general;
  if (!session.turns.some((t) => t.userText)) return null; // nothing said, no card

  const card = (config.mockExternal || !config.ai.apiKey) ? mockCard(m) : await llmScore(m, session.turns);
  card.scoreValue = clampScore(card.scoreValue, m.scoreMax);
  card.mode = session.mode;

  await prisma.voiceSession.update({ where: { id: sessionId }, data: { scoreCard: card } });
  return withShare(userId, card);
}