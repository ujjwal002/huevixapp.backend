// Pure spaced-repetition + quiz-selection logic for the vocab tutor.
// No DB / IO here so the tricky bits can be unit-tested directly.

const DAY_MS = 24 * 60 * 60 * 1000;

// Leitner intervals by strength box (0..5): a word at strength s becomes due
// this many days after it was last tested. Misses send it back to box 0.
export const BOX_INTERVAL_DAYS = [1, 3, 7, 16, 35, 90];
export const MAX_STRENGTH = BOX_INTERVAL_DAYS.length - 1;

export function intervalDaysForStrength(strength) {
  const s = Math.max(0, Math.min(MAX_STRENGTH, strength));
  return BOX_INTERVAL_DAYS[s];
}

export function dueDateFor(strength, from = new Date()) {
  return new Date(from.getTime() + intervalDaysForStrength(strength) * DAY_MS);
}

// SRS update after a quiz result. Correct promotes one box; a miss drops the
// word straight back to box 0 ("go relearn it"). Returns fields to persist.
export function applyAnswer(prev, correct, now = new Date()) {
  const prevStrength = prev?.strength ?? 0;
  const strength = correct ? Math.min(MAX_STRENGTH, prevStrength + 1) : 0;
  return {
    strength,
    timesTested: (prev?.timesTested ?? 0) + 1,
    timesCorrect: (prev?.timesCorrect ?? 0) + (correct ? 1 : 0),
    consecutiveHits: correct ? (prev?.consecutiveHits ?? 0) + 1 : 0,
    lastTestedAt: now,
    dueAt: dueDateFor(strength, now),
  };
}

// Initial SRS state for a word the tutor just taught for the first time:
// strength 0, due again tomorrow.
export function freshlyTaught(now = new Date()) {
  return {
    strength: 0,
    timesTested: 0,
    timesCorrect: 0,
    consecutiveHits: 0,
    lastTestedAt: null,
    dueAt: dueDateFor(0, now),
  };
}

// Choose which learned words to quiz today. Prefers due + weak words, then
// fills (if short) with the soonest-due of the rest. `progress` items need
// { wordId, strength, dueAt }.
export function selectQuizWordIds(progress, now = new Date(), count = 6) {
  const isDue = (p) => p.dueAt && new Date(p.dueAt) <= now;
  const byOverdueThenWeak = (a, b) => {
    const ad = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
    const bd = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
    if (ad !== bd) return ad - bd; // most overdue first
    return (a.strength ?? 0) - (b.strength ?? 0); // weaker first
  };
  const due = progress.filter(isDue).sort(byOverdueThenWeak);
  const notDue = progress.filter((p) => !isDue(p)).sort(byOverdueThenWeak);
  return [...due, ...notDue].slice(0, count).map((p) => p.wordId);
}

// Per-quiz-item attempt logic. The tutor gives ONE retry on a miss, then moves
// on. Given how many attempts already happened for this word:
//   attemptsSoFar = 0, correct       -> 'passed'
//   attemptsSoFar = 0, wrong         -> 'retry'  (reteach + ask again)
//   attemptsSoFar >= 1 (any result)  -> 'passed' | 'failed' (final, move on)
export function quizOutcome(attemptsSoFar, correct) {
  if (correct) return 'passed';
  if (attemptsSoFar >= 1) return 'failed';
  return 'retry';
}
