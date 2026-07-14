import { describe, it, expect, afterEach } from 'vitest';
import { config } from '../src/config/env.js';
import { periodOf } from '../src/services/quiz.service.js';
import { generateQuizQuestions, QUIZ_QUESTION_COUNT } from '../src/services/quizAi.service.js';
import {
  submitAnswerSchema,
  leaderboardQuerySchema,
  winnerAcceptSchema,
  adminSelectWinnerSchema,
} from '../src/validators/quiz.schemas.js';

// These are pure-function / validator tests (no database), matching the style
// of the existing suite. The DB-backed flows (scoring, leaderboard, winner
// selection) need a test database for true integration tests — happy to add
// those separately.

const original = { mockExternal: config.mockExternal };
afterEach(() => {
  config.mockExternal = original.mockExternal;
});

describe('periodOf (UTC YYYY-MM)', () => {
  it('formats the month with zero padding', () => {
    expect(periodOf(new Date('2026-07-01T00:00:00Z'))).toBe('2026-07');
    expect(periodOf(new Date('2026-01-15T12:00:00Z'))).toBe('2026-01');
    expect(periodOf(new Date('2026-12-31T23:00:00Z'))).toBe('2026-12');
  });

  it('uses UTC, not local time', () => {
    // 00:30 UTC on Aug 1 is still 31 Jul in IST (UTC+5:30) — must read as Aug.
    expect(periodOf(new Date('2026-08-01T00:30:00Z'))).toBe('2026-08');
  });
});

describe('generateQuizQuestions (mock mode)', () => {
  it('returns exactly the configured number of questions (20)', async () => {
    config.mockExternal = true;
    const qs = await generateQuizQuestions();
    expect(QUIZ_QUESTION_COUNT).toBe(20);
    expect(qs).toHaveLength(QUIZ_QUESTION_COUNT);
  });

  it('every question is well-formed and carries a server-side correct answer', async () => {
    config.mockExternal = true;
    const qs = await generateQuizQuestions();
    for (const q of qs) {
      expect(typeof q.prompt).toBe('string');
      expect(q.prompt.length).toBeGreaterThan(0);
      expect(Array.isArray(q.options)).toBe(true);
      expect(q.options).toHaveLength(4);
      expect(q.options.every((o) => typeof o === 'string' && o.length > 0)).toBe(true);
      // correctIndex must exist and point to a real option. This is what the
      // server scores against and is NEVER sent to the client before answering.
      expect(Number.isInteger(q.correctIndex)).toBe(true);
      expect(q.correctIndex).toBeGreaterThanOrEqual(0);
      expect(q.correctIndex).toBeLessThan(4);
      expect(q.options[q.correctIndex]).toBeDefined();
    }
  });
});

describe('submitAnswerSchema', () => {
  it('accepts a valid answer', () => {
    expect(submitAnswerSchema.body.safeParse({ questionId: 'q1', chosenIndex: 2 }).success).toBe(
      true
    );
  });

  it('rejects a missing questionId', () => {
    expect(submitAnswerSchema.body.safeParse({ chosenIndex: 1 }).success).toBe(false);
  });

  it('rejects an out-of-range or non-integer choice', () => {
    expect(submitAnswerSchema.body.safeParse({ questionId: 'q1', chosenIndex: -1 }).success).toBe(
      false
    );
    expect(submitAnswerSchema.body.safeParse({ questionId: 'q1', chosenIndex: 10 }).success).toBe(
      false
    );
    expect(submitAnswerSchema.body.safeParse({ questionId: 'q1', chosenIndex: 1.5 }).success).toBe(
      false
    );
  });
});

describe('leaderboardQuerySchema', () => {
  it('defaults limit to 20 when absent', () => {
    const r = leaderboardQuerySchema.query.safeParse({});
    expect(r.success).toBe(true);
    expect(r.data.limit).toBe(20);
  });

  it('coerces a numeric string and rejects values over 100', () => {
    expect(leaderboardQuerySchema.query.safeParse({ limit: '50' }).data.limit).toBe(50);
    expect(leaderboardQuerySchema.query.safeParse({ limit: '500' }).success).toBe(false);
  });
});

describe('winnerAcceptSchema', () => {
  it('accepts a phone, with an optional preferred role', () => {
    expect(
      winnerAcceptSchema.body.safeParse({ contactPhone: '9876543210', preferredRole: 'Writer' })
        .success
    ).toBe(true);
    expect(winnerAcceptSchema.body.safeParse({ contactPhone: '9876543210' }).success).toBe(true);
  });

  it('rejects a missing or too-short phone', () => {
    expect(winnerAcceptSchema.body.safeParse({ preferredRole: 'Writer' }).success).toBe(false);
    expect(winnerAcceptSchema.body.safeParse({ contactPhone: '12' }).success).toBe(false);
  });
});

describe('adminSelectWinnerSchema', () => {
  it('accepts a valid YYYY-MM period', () => {
    expect(adminSelectWinnerSchema.body.safeParse({ period: '2026-07' }).success).toBe(true);
  });

  it('rejects a malformed period', () => {
    for (const bad of ['2026-7', '2026/07', 'July', '26-07']) {
      expect(adminSelectWinnerSchema.body.safeParse({ period: bad }).success).toBe(false);
    }
  });
});
