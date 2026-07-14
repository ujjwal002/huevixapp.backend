import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { startOfUtcDay } from '../utils/dates.js';
import { isSubscriptionActive } from '../services/entitlement.service.js';
import { selectQuizWordIds, quizOutcome } from '../services/vocabTutor.logic.js';
import {
  assertSubscribed,
  pickNewWordIds,
  loadProgressForSelection,
  countLearned,
  getWord,
  ensureWordAudio,
  recordAnswer,
  recordTaught,
} from '../services/vocabTutor.service.js';
import { synthesizeHindi } from '../services/tts.service.js';
import { transcribeOnce } from '../services/speech.service.js';
import { judgeAndReact, line } from '../services/tutorAi.service.js';

// ---- lesson state machine (pure-ish helpers over the session.state JSON) ----
// state = { phase: 'quiz'|'teach'|'done', quiz:[{wordId,attempts,finalCorrect}], qi, teach:[wordId], ti }

function normalizePhase(state) {
  if (state.phase === 'quiz' && state.qi >= state.quiz.length) {
    state.phase = state.teach.length ? 'teach' : 'done';
  }
  if (state.phase === 'teach' && state.ti >= state.teach.length) {
    state.phase = 'done';
  }
  return state;
}

function currentStep(state) {
  if (state.phase === 'quiz' && state.qi < state.quiz.length) {
    return { kind: 'ask', wordId: state.quiz[state.qi].wordId, expects: 'answer' };
  }
  if (state.phase === 'teach' && state.ti < state.teach.length) {
    return { kind: 'teach', wordId: state.teach[state.ti], expects: 'continue' };
  }
  return { kind: 'closing', wordId: null, expects: 'done' };
}

async function promptText(step, word, stats) {
  if (step.kind === 'closing') return (await line({ kind: 'closing', stats })).text;
  return (await line({ kind: step.kind, word, stats })).text;
}

// Synthesize the Hindi line(s) for this turn, and attach the (cached) English
// word audio when a specific word is being asked or taught.
async function renderTurn(textParts, word) {
  const text = textParts.filter(Boolean).join(' ');
  const { url: hindiAudioUrl } = await synthesizeHindi(text);
  const wordAudioUrl = word ? await ensureWordAudio(word) : null;
  return { text, hindiAudioUrl, wordAudioUrl };
}

// POST /vocab-tutor/start — open (or resume) today's session and return the
// opening line. First-ever visit skips the quiz and goes straight to teaching.
export const startSession = asyncHandler(async (req, res) => {
  await assertSubscribed(req.user);
  const userId = req.user.id;
  const day = startOfUtcDay();

  let session = await prisma.vocabTutorSession.findUnique({
    where: { userId_day: { userId, day } },
  });

  if (session && session.endedAt) {
    const closing = (
      await line({
        kind: 'closing',
        stats: { correct: session.correctCount, quizzed: session.quizzedCount },
      })
    ).text;
    const ai = await renderTurn([closing], null);
    return res.json({
      sessionId: session.id,
      phase: 'done',
      done: true,
      alreadyDone: true,
      expects: 'done',
      ai,
    });
  }

  if (!session) {
    const firstTime = (await countLearned(userId)) === 0;
    let quiz = [];
    if (!firstTime) {
      const progress = await loadProgressForSelection(userId);
      const ids = selectQuizWordIds(progress, new Date(), config.tutor.quizCount);
      quiz = ids.map((wordId) => ({ wordId, attempts: 0, finalCorrect: null }));
    }
    const teach = await pickNewWordIds(userId, config.tutor.newWordsPerDay);
    const phase = quiz.length ? 'quiz' : 'teach';
    session = await prisma.vocabTutorSession.create({
      data: { userId, day, state: { phase, quiz, qi: 0, teach, ti: 0 } },
    });
  }

  const state = session.state;
  normalizePhase(state);
  const step = currentStep(state);
  const word = await getWord(step.wordId);
  const stats = { correct: session.correctCount, quizzed: session.quizzedCount };
  const willQuiz = state.phase === 'quiz';
  const firstTime = (await countLearned(userId)) === 0;
  const greeting = (await line({ kind: 'greeting', firstTime, willQuiz })).text;
  const stepText = await promptText(step, word, stats);
  const audioWord = step.kind === 'ask' || step.kind === 'teach' ? word : null;
  const ai = await renderTurn([greeting, stepText], audioWord);

  res.json({
    sessionId: session.id,
    phase: state.phase,
    done: step.expects === 'done',
    expects: step.expects,
    ai,
  });
});

// POST /vocab-tutor/turn — process the learner's response to the previous step
// (a spoken answer during a quiz, or "continue" during teaching) and return the
// next step. Drives SRS bookkeeping deterministically; the LLM only judges +
// voices the roaster.
export const turn = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  await assertSubscribed(req.user);
  const day = startOfUtcDay();

  const session = await prisma.vocabTutorSession.findUnique({
    where: { userId_day: { userId, day } },
  });
  if (!session)
    throw ApiError.badRequest('No active tutor session today. Call /start first.', 'NO_SESSION');
  if (session.endedAt) return res.json({ phase: 'done', done: true, alreadyDone: true });

  const state = session.state;
  normalizePhase(state);
  if (session.turns >= config.tutor.maxTurnsPerSession) state.phase = 'done'; // cost guard

  const step = currentStep(state);
  let reactionText = null;
  let isRetry = false;
  const counters = { quizzed: 0, correct: 0, taught: 0 };

  if (state.phase === 'quiz' && step.expects === 'answer') {
    if (!req.file)
      throw ApiError.badRequest('Expected an audio answer (field "audio")', 'AUDIO_REQUIRED');
    const item = state.quiz[state.qi];
    const word = await getWord(item.wordId);
    const { text: transcript } = await transcribeOnce({
      audioBuffer: req.file.buffer,
      locale: 'hi-IN',
    });
    const { correct, text } = await judgeAndReact({
      word,
      answer: transcript,
      attemptsSoFar: item.attempts,
    });
    reactionText = text;
    const outcome = quizOutcome(item.attempts, correct);
    item.attempts += 1;
    if (outcome === 'retry') {
      isRetry = true; // the reaction already reteaches + re-asks the same word
    } else {
      const passed = outcome === 'passed';
      item.finalCorrect = passed;
      await recordAnswer(userId, item.wordId, passed);
      counters.quizzed += 1;
      if (passed) counters.correct += 1;
      state.qi += 1;
      normalizePhase(state);
    }
  } else if (state.phase === 'teach' && step.expects === 'continue') {
    await recordTaught(userId, state.teach[state.ti]);
    counters.taught += 1;
    state.ti += 1;
    normalizePhase(state);
  }

  const stats = {
    correct: session.correctCount + counters.correct,
    quizzed: session.quizzedCount + counters.quizzed,
  };

  const parts = [];
  if (reactionText) parts.push(reactionText);

  let next = step;
  let audioWord = null;
  let done = false;

  if (!isRetry) {
    next = currentStep(state);
    done = next.expects === 'done';
    const nextWord = done ? null : await getWord(next.wordId);
    parts.push(
      done ? await promptText(next, null, stats) : await promptText(next, nextWord, stats)
    );
    if (!done && (next.kind === 'ask' || next.kind === 'teach')) audioWord = nextWord;
  }

  const ai = await renderTurn(parts, audioWord);

  await prisma.vocabTutorSession.update({
    where: { id: session.id },
    data: {
      state,
      turns: { increment: 1 },
      quizzedCount: { increment: counters.quizzed },
      correctCount: { increment: counters.correct },
      taughtCount: { increment: counters.taught },
      ...(done ? { endedAt: new Date() } : {}),
    },
  });

  res.json({ phase: state.phase, done, expects: isRetry ? 'answer' : next.expects, ai });
});

// POST /vocab-tutor/end — let the learner bail early; just close the session.
export const endSession = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const day = startOfUtcDay();
  await prisma.vocabTutorSession.updateMany({
    where: { userId, day, endedAt: null },
    data: { endedAt: new Date() },
  });
  res.json({ ended: true });
});

// GET /vocab-tutor/status — small dashboard: words known, how many are due,
// whether today's session is started/done, and if the tutor is unlocked.
export const status = asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const now = new Date();
  const [u, learned, due, session] = await Promise.all([
    prisma.user.findUnique({ where: { id: userId }, include: { subscription: true } }),
    countLearned(userId),
    prisma.vocabProgress.count({ where: { userId, dueAt: { lte: now } } }),
    prisma.vocabTutorSession.findUnique({
      where: { userId_day: { userId, day: startOfUtcDay() } },
      select: { endedAt: true, taughtCount: true, quizzedCount: true, correctCount: true },
    }),
  ]);
  res.json({
    unlocked: isSubscriptionActive(u),
    learnedWords: learned,
    dueNow: due,
    todayStarted: !!session,
    todayDone: !!session?.endedAt,
    today: session
      ? {
          taught: session.taughtCount,
          quizzed: session.quizzedCount,
          correct: session.correctCount,
        }
      : null,
  });
});
