import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { config } from '../src/config/env.js';

// =============================================================================
// Integration tests for the DB-backed quiz flows: scoring, points, the
// "one answer per question" rule, leaderboard ordering, and winner selection.
//
// These hit a REAL Postgres, so they only run when you point them at a
// throwaway test database. If TEST_DATABASE_URL is not set, the whole suite is
// skipped (so your normal `npm test` is unaffected).
//
// HOW TO RUN (one-time setup of a scratch DB):
//   1. createdb huevix_test                        # or any empty Postgres DB
//   2. TEST_DATABASE_URL="postgresql://USER:PASS@localhost:5432/huevix_test" \
//        npx prisma migrate deploy                 # apply your schema to it
//   3. TEST_DATABASE_URL="postgresql://USER:PASS@localhost:5432/huevix_test" \
//        npm test
//
// It NEVER touches your real database — it only uses TEST_DATABASE_URL.
// =============================================================================

const TEST_DB = process.env.TEST_DATABASE_URL;
const run = TEST_DB ? describe : describe.skip;

// Point Prisma at the test DB BEFORE the client is created.
if (TEST_DB) process.env.DATABASE_URL = TEST_DB;
// Force mock mode so question generation never calls a real AI API.
config.mockExternal = true;

run('quiz DB flows (integration)', () => {
  let prisma;
  let svc;
  let userId;
  let user2Id;

  beforeAll(async () => {
    prisma = (await import('../src/db/prisma.js')).prisma;
    svc = await import('../src/services/quiz.service.js');
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  // Fresh users + clean quiz tables before each test so they don't interfere.
  beforeEach(async () => {
    await prisma.quizAnswer.deleteMany({});
    await prisma.quizDailyPlay.deleteMany({});
    await prisma.quizQuestion.deleteMany({});
    await prisma.dailyQuiz.deleteMany({});
    await prisma.quizMonthlyScore.deleteMany({});
    await prisma.monthlyWinner.deleteMany({});
    // Remove the test users (cascades clear any leftover quiz rows).
    await prisma.user.deleteMany({
      where: { email: { in: ['quiz_t1@test.local', 'quiz_t2@test.local'] } },
    });

    const u1 = await prisma.user.create({
      data: {
        email: 'quiz_t1@test.local',
        passwordHash: 'x',
        name: 'Tester One',
        targetLanguage: 'en',
      },
    });
    const u2 = await prisma.user.create({
      data: {
        email: 'quiz_t2@test.local',
        passwordHash: 'x',
        name: 'Tester Two',
        targetLanguage: 'en',
      },
    });
    userId = u1.id;
    user2Id = u2.id;
  });

  async function loadUser(id) {
    // getTodayForUser / submitAnswer expect a user object with subscription.
    return prisma.user.findUnique({ where: { id }, include: { subscription: true } });
  }

  it('serves 20 questions and never leaks the correct answer', async () => {
    const user = await loadUser(userId);
    const today = await svc.getTodayForUser(user);

    expect(today.totalQuestions).toBe(20);
    expect(today.questions).toHaveLength(20);
    // The serialized questions must NOT contain correctIndex.
    for (const q of today.questions) {
      expect(q).not.toHaveProperty('correctIndex');
      expect(Array.isArray(q.options)).toBe(true);
    }
    // ...but the answer IS stored server-side in the DB.
    const dbQ = await prisma.quizQuestion.findFirst({ where: { id: today.questions[0].id } });
    expect(Number.isInteger(dbQ.correctIndex)).toBe(true);
  });

  it('awards points for a correct answer and zero for a wrong one', async () => {
    const user = await loadUser(userId);
    await svc.getTodayForUser(user); // generates today's quiz
    const q = await prisma.quizQuestion.findFirst({ where: { order: 0 } });

    // Correct answer.
    const correct = await svc.submitAnswer(user, { questionId: q.id, chosenIndex: q.correctIndex });
    expect(correct.correct).toBe(true);
    expect(correct.pointsAwarded).toBe(10);

    // A second, different question answered wrong.
    const q2 = await prisma.quizQuestion.findFirst({ where: { order: 1 } });
    const wrongChoice = (q2.correctIndex + 1) % 4;
    const wrong = await svc.submitAnswer(user, { questionId: q2.id, chosenIndex: wrongChoice });
    expect(wrong.correct).toBe(false);
    expect(wrong.pointsAwarded).toBe(0);
  });

  it('refuses to score the same question twice (no point farming)', async () => {
    const user = await loadUser(userId);
    await svc.getTodayForUser(user);
    const q = await prisma.quizQuestion.findFirst({ where: { order: 0 } });

    const first = await svc.submitAnswer(user, { questionId: q.id, chosenIndex: q.correctIndex });
    expect(first.correct).toBe(true);

    const second = await svc.submitAnswer(user, { questionId: q.id, chosenIndex: q.correctIndex });
    expect(second.error).toBe('ALREADY_ANSWERED');

    // Only one answer row exists, and the monthly total reflects a single award.
    const answers = await prisma.quizAnswer.count({ where: { userId, questionId: q.id } });
    expect(answers).toBe(1);
  });

  it('completing all 20 grants the completion bonus and starts a streak', async () => {
    const user = await loadUser(userId);
    await svc.getTodayForUser(user);
    const qs = await prisma.quizQuestion.findMany({ where: {}, orderBy: { order: 'asc' } });

    let lastCompleted = false;
    for (const q of qs) {
      const r = await svc.submitAnswer(user, { questionId: q.id, chosenIndex: q.correctIndex });
      lastCompleted = r.completed;
    }
    // The final answer reports completion + a bonus on top of the 10 points.
    expect(lastCompleted).toBe(true);

    const status = await svc.getMyQuizStatus(user);
    expect(status.today.completed).toBe(true);
    expect(status.today.correct).toBe(20);
    expect(status.streak).toBe(1);
    // 20 correct * 10 = 200, plus a completion bonus (base 20 + streak bonus).
    expect(status.monthlyPoints).toBeGreaterThan(200);
  });

  it('ranks the leaderboard by points, and picks the top scorer as winner', async () => {
    const u1 = await loadUser(userId);
    const u2 = await loadUser(user2Id);
    await svc.getTodayForUser(u1); // generate today's quiz once
    const qs = await prisma.quizQuestion.findMany({ where: {}, orderBy: { order: 'asc' } });

    // User 1 answers ALL correct; user 2 answers only the first 3 correct.
    for (const q of qs) {
      await svc.submitAnswer(u1, { questionId: q.id, chosenIndex: q.correctIndex });
    }
    for (const q of qs.slice(0, 3)) {
      await svc.submitAnswer(u2, { questionId: q.id, chosenIndex: q.correctIndex });
    }

    const board = await svc.getLeaderboard(u1, { limit: 10 });
    expect(board.items[0].name).toBe('Tester One'); // highest points first
    expect(board.items[0].points).toBeGreaterThan(board.items[1].points);

    // Select the winner for the current period.
    const period = svc.periodOf();
    const result = await svc.selectWinner(period, { note: 'top performer' });
    expect(result.winner.userId).toBe(userId);

    // Idempotent: selecting again for the same period is rejected.
    const again = await svc.selectWinner(period, {});
    expect(again.error).toBe('ALREADY_SELECTED');
  });

  it('voiding a question claws back the points it awarded', async () => {
    const user = await loadUser(userId);
    await svc.getTodayForUser(user);
    const q = await prisma.quizQuestion.findFirst({ where: { order: 0 } });

    await svc.submitAnswer(user, { questionId: q.id, chosenIndex: q.correctIndex });
    const before = await svc.getMyQuizStatus(user);
    expect(before.monthlyPoints).toBe(10);

    const voided = await svc.voidQuestion(q.id);
    expect(voided.ok).toBe(true);
    expect(voided.refundedUsers).toBe(1);

    const after = await svc.getMyQuizStatus(user);
    expect(after.monthlyPoints).toBe(0); // the 10 points were removed
  });
});
