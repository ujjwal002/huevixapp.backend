import { describe, it, expect } from 'vitest';
import {
  intervalDaysForStrength,
  dueDateFor,
  applyAnswer,
  freshlyTaught,
  selectQuizWordIds,
  quizOutcome,
  MAX_STRENGTH,
} from '../src/services/vocabTutor.logic.js';

const NOW = new Date('2026-06-20T00:00:00Z');
const daysFromNow = (d) => new Date(NOW.getTime() + d * 86400000);

describe('intervalDaysForStrength', () => {
  it('clamps to the valid box range', () => {
    expect(intervalDaysForStrength(0)).toBe(1);
    expect(intervalDaysForStrength(-5)).toBe(1);
    expect(intervalDaysForStrength(99)).toBe(intervalDaysForStrength(MAX_STRENGTH));
  });
});

describe('applyAnswer', () => {
  it('promotes one box on a correct answer and pushes dueAt out', () => {
    const r = applyAnswer({ strength: 1, timesTested: 2, timesCorrect: 1, consecutiveHits: 1 }, true, NOW);
    expect(r.strength).toBe(2);
    expect(r.timesTested).toBe(3);
    expect(r.timesCorrect).toBe(2);
    expect(r.consecutiveHits).toBe(2);
    expect(r.dueAt.getTime()).toBe(dueDateFor(2, NOW).getTime());
  });

  it('drops back to box 0 and due-tomorrow on a miss, and resets the streak', () => {
    const r = applyAnswer({ strength: 4, timesTested: 9, timesCorrect: 8, consecutiveHits: 5 }, false, NOW);
    expect(r.strength).toBe(0);
    expect(r.consecutiveHits).toBe(0);
    expect(r.timesCorrect).toBe(8);
    expect(r.dueAt.getTime()).toBe(daysFromNow(1).getTime());
  });

  it('never exceeds the max box', () => {
    const r = applyAnswer({ strength: MAX_STRENGTH }, true, NOW);
    expect(r.strength).toBe(MAX_STRENGTH);
  });
});

describe('freshlyTaught', () => {
  it('starts at strength 0, untested, due tomorrow', () => {
    const r = freshlyTaught(NOW);
    expect(r.strength).toBe(0);
    expect(r.timesTested).toBe(0);
    expect(r.lastTestedAt).toBeNull();
    expect(r.dueAt.getTime()).toBe(daysFromNow(1).getTime());
  });
});

describe('selectQuizWordIds', () => {
  it('prefers the most-overdue and weakest words and caps at count', () => {
    const progress = [
      { wordId: 'a', strength: 3, dueAt: daysFromNow(5) }, // not due
      { wordId: 'b', strength: 0, dueAt: daysFromNow(-3) }, // very overdue, weak
      { wordId: 'c', strength: 2, dueAt: daysFromNow(-1) }, // overdue
      { wordId: 'd', strength: 1, dueAt: daysFromNow(-3) }, // very overdue (tie with b -> weaker first)
    ];
    const picked = selectQuizWordIds(progress, NOW, 2);
    expect(picked).toEqual(['b', 'd']); // both -3 days; b (str 0) before d (str 1)
  });

  it('fills from not-yet-due words when too few are due', () => {
    const progress = [
      { wordId: 'a', strength: 0, dueAt: daysFromNow(-1) }, // due
      { wordId: 'b', strength: 1, dueAt: daysFromNow(2) }, // soonest not-due
      { wordId: 'c', strength: 4, dueAt: daysFromNow(9) }, // later not-due
    ];
    const picked = selectQuizWordIds(progress, NOW, 6);
    expect(picked).toEqual(['a', 'b', 'c']);
  });
});

describe('quizOutcome', () => {
  it('gives one retry on the first miss, then a final result', () => {
    expect(quizOutcome(0, true)).toBe('passed');
    expect(quizOutcome(0, false)).toBe('retry');
    expect(quizOutcome(1, false)).toBe('failed');
    expect(quizOutcome(1, true)).toBe('passed');
  });
});