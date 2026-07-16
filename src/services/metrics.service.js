import { prisma } from '../db/prisma.js';

/**
 * Investor-grade metrics, computed live from the DB.
 *
 * Every section is independently try/caught: if one table/column doesn't match
 * this schema (the app evolves fast), that section returns null and the rest of
 * the dashboard still renders — one bad query never blanks the page.
 *
 * Money constants:
 *  - 1 coin ≈ ₹0.00825 (₹99 pack = 12,000 coins)
 *  - Gaja variable cost ≈ ₹2 / conversation-minute (Sarvam+GPT, measured)
 */
const COIN_INR = 99 / 12000;
const VOICE_COST_PER_MIN_INR = Number(process.env.METRICS_VOICE_COST_PER_MIN_INR || 2);

// $queryRaw returns BigInt for counts — JSON.stringify explodes on those.
function num(v) {
  if (typeof v === 'bigint') return Number(v);
  if (v === null || v === undefined) return 0;
  return Number(v);
}
function rows(list, fields) {
  return (list || []).map((r) => {
    const o = {};
    for (const f of fields) o[f] = r[f] instanceof Date ? r[f].toISOString().slice(0, 10) : num(r[f]);
    return o;
  });
}
async function section(fn) {
  try { return await fn(); } catch (e) {
    console.error('[metrics] section failed:', e.message);
    return null;
  }
}

// Activity = any of: completed a quiz day, started a voice session. Two-tier:
// richer union first, simple fallback if a table is missing.
const ACT_CTE = `
  act AS (
    SELECT "userId", date_trunc('day', "completedAt") AS d
      FROM "QuizDailyPlay" WHERE "completedAt" IS NOT NULL
    UNION
    SELECT "userId", date_trunc('day', "startedAt") FROM "VoiceSession"
  )`;
const ACT_CTE_FALLBACK = `
  act AS (
    SELECT "userId", date_trunc('day', "completedAt") AS d
      FROM "QuizDailyPlay" WHERE "completedAt" IS NOT NULL
  )`;

async function withActivity(sql) {
  try { return await prisma.$queryRawUnsafe(`WITH ${ACT_CTE} ${sql}`); }
  catch { return await prisma.$queryRawUnsafe(`WITH ${ACT_CTE_FALLBACK} ${sql}`); }
}

export async function collectMetrics({ days = 30 } = {}) {
  const d = Math.min(120, Math.max(7, Number(days) || 30));

  const [users, activity, retention, quiz, voice, referrals, content, economy] =
    await Promise.all([
      // ---------------- Users & growth ----------------
      section(async () => {
        const total = await prisma.user.count();
        const [row] = await prisma.$queryRawUnsafe(`
          SELECT
            count(*) FILTER (WHERE "createdAt" >= now() - interval '1 day')  AS today,
            count(*) FILTER (WHERE "createdAt" >= now() - interval '7 day')  AS week,
            count(*) FILTER (WHERE "createdAt" >= now() - interval '30 day') AS month
          FROM "User"`);
        const series = await prisma.$queryRawUnsafe(`
          SELECT gs::date AS day, count(u.id) AS signups
          FROM generate_series(now()::date - ${d - 1}, now()::date, '1 day') gs
          LEFT JOIN "User" u ON date_trunc('day', u."createdAt") = gs
          GROUP BY gs ORDER BY gs`);
        return {
          total, newToday: num(row.today), new7d: num(row.week), new30d: num(row.month),
          signupSeries: rows(series, ['day', 'signups']),
        };
      }),

      // ---------------- DAU / WAU / MAU + series ----------------
      section(async () => {
        const [row] = await withActivity(`
          SELECT
            (SELECT count(DISTINCT "userId") FROM act WHERE d >= now() - interval '1 day')  AS dau,
            (SELECT count(DISTINCT "userId") FROM act WHERE d >= now() - interval '7 day')  AS wau,
            (SELECT count(DISTINCT "userId") FROM act WHERE d >= now() - interval '30 day') AS mau`);
        const series = await withActivity(`
          SELECT gs::date AS day, count(DISTINCT a."userId") AS dau
          FROM generate_series(now()::date - ${d - 1}, now()::date, '1 day') gs
          LEFT JOIN act a ON a.d = gs
          GROUP BY gs ORDER BY gs`);
        const dau = num(row.dau), mau = num(row.mau);
        return {
          dau, wau: num(row.wau), mau,
          stickiness: mau ? Math.round((dau / mau) * 100) : 0, // DAU/MAU %
          dauSeries: rows(series, ['day', 'dau']),
        };
      }),

      // ---------------- Cohort retention D1 / D7 / D30 ----------------
      section(async () => {
        const [r] = await withActivity(`
          , u AS (SELECT id, date_trunc('day', "createdAt") AS d0 FROM "User")
          SELECT
            count(*) FILTER (WHERE d0 <= now() - interval '1 day')  AS c1,
            count(*) FILTER (WHERE d0 <= now() - interval '1 day'
              AND EXISTS (SELECT 1 FROM act a WHERE a."userId" = u.id AND a.d >= u.d0 + interval '1 day'  AND a.d < u.d0 + interval '2 day'))  AS r1,
            count(*) FILTER (WHERE d0 <= now() - interval '7 day')  AS c7,
            count(*) FILTER (WHERE d0 <= now() - interval '7 day'
              AND EXISTS (SELECT 1 FROM act a WHERE a."userId" = u.id AND a.d >= u.d0 + interval '7 day'  AND a.d < u.d0 + interval '8 day'))  AS r7,
            count(*) FILTER (WHERE d0 <= now() - interval '30 day') AS c30,
            count(*) FILTER (WHERE d0 <= now() - interval '30 day'
              AND EXISTS (SELECT 1 FROM act a WHERE a."userId" = u.id AND a.d >= u.d0 + interval '30 day' AND a.d < u.d0 + interval '31 day')) AS r30
          FROM u`);
        const pct = (rr, c) => (num(c) ? Math.round((num(rr) / num(c)) * 1000) / 10 : null);
        return {
          d1: pct(r.r1, r.c1),  d1Cohort: num(r.c1),
          d7: pct(r.r7, r.c7),  d7Cohort: num(r.c7),
          d30: pct(r.r30, r.c30), d30Cohort: num(r.c30),
        };
      }),

      // ---------------- Quiz engagement ----------------
      section(async () => {
        const [row] = await prisma.$queryRawUnsafe(`
          SELECT
            count(*) FILTER (WHERE "completedAt" >= now() - interval '1 day') AS today,
            count(*) FILTER (WHERE "completedAt" >= now() - interval '7 day') AS week,
            count(*) FILTER (WHERE "completedAt" IS NOT NULL)                 AS total
          FROM "QuizDailyPlay"`);
        const [streak] = await prisma.$queryRawUnsafe(`
          SELECT count(*) AS users30 FROM (
            SELECT "userId" FROM "QuizDailyPlay" WHERE "completedAt" IS NOT NULL
            GROUP BY "userId" HAVING count(*) >= 30
          ) t`);
        return {
          completedToday: num(row.today), completed7d: num(row.week),
          completedTotal: num(row.total), usersWith30Days: num(streak.users30),
        };
      }),

      // ---------------- Gaja voice ----------------
      section(async () => {
        const [row] = await prisma.$queryRawUnsafe(`
          SELECT
            count(*)                                                        AS sessions,
            count(*) FILTER (WHERE "startedAt" >= now() - interval '1 day') AS today,
            count(*) FILTER (WHERE "startedAt" >= now() - interval '7 day') AS week,
            coalesce(sum("userAudioSec" + "aiAudioSec"), 0)                 AS audiosec,
            coalesce(sum("coinsSpent"), 0)                                  AS coins,
            coalesce(avg(nullif("turnCount", 0)), 0)                        AS avgturns
          FROM "VoiceSession"`);
        const modes = await prisma.$queryRawUnsafe(`
          SELECT mode, count(*) AS sessions FROM "VoiceSession" GROUP BY mode ORDER BY sessions DESC`);
        const minutes = Math.round(num(row.audiosec) / 60);
        const revenueInr = Math.round(num(row.coins) * COIN_INR);
        const costInr = Math.round(minutes * VOICE_COST_PER_MIN_INR);
        return {
          sessionsTotal: num(row.sessions), sessionsToday: num(row.today), sessions7d: num(row.week),
          minutesTotal: minutes, avgTurnsPerSession: Math.round(num(row.avgturns) * 10) / 10,
          coinsSpent: num(row.coins), revenueInr, estCostInr: costInr, estMarginInr: revenueInr - costInr,
          modes: rows(modes, ['mode', 'sessions']),
        };
      }),

      // ---------------- Referrals ----------------
      section(async () => {
        const byStatus = await prisma.referral.groupBy({ by: ['status'], _count: true });
        const m = Object.fromEntries(byStatus.map((b) => [b.status, b._count]));
        const qualified = m.QUALIFIED || 0;
        const paidAgg = await prisma.referralPayout.aggregate({
          where: { status: 'PAID' }, _sum: { amountPaise: true }, _count: true,
        });
        const pendingAgg = await prisma.referralPayout.aggregate({
          where: { status: 'PENDING' }, _sum: { amountPaise: true }, _count: true,
        });
        const paidInr = Math.round(num(paidAgg._sum.amountPaise) / 100);
        return {
          total: byStatus.reduce((s, b) => s + b._count, 0),
          pending: m.PENDING || 0, qualified,
          liabilityInr: qualified * 100 - paidInr, // accrued − already paid
          payoutsPending: pendingAgg._count, payoutsPendingInr: Math.round(num(pendingAgg._sum.amountPaise) / 100),
          payoutsPaid: paidAgg._count, payoutsPaidInr: paidInr,
        };
      }),

      // ---------------- Content ----------------
      section(async () => {
        const [row] = await prisma.$queryRawUnsafe(`
          SELECT
            count(*)                                                          AS total,
            count(*) FILTER (WHERE "isPublished")                             AS published,
            count(*) FILTER (WHERE "createdAt" >= now() - interval '7 day')   AS new7d,
            count(*) FILTER (WHERE "audioStatus" = 'READY')                   AS audioready,
            count(*) FILTER (WHERE "audioStatus" IN ('PENDING','FAILED'))     AS audiomissing
          FROM "Card"`);
        return {
          cardsTotal: num(row.total), published: num(row.published), new7d: num(row.new7d),
          audioReady: num(row.audioready), audioMissing: num(row.audiomissing),
        };
      }),

      // ---------------- Coin economy ----------------
      section(async () => {
        const agg = await prisma.user.aggregate({ _sum: { coinBalance: true } });
        const coins = num(agg._sum.coinBalance);
        return { coinsInWallets: coins, walletLiabilityInr: Math.round(coins * COIN_INR) };
      }),
    ]);

  return {
    generatedAt: new Date().toISOString(),
    windowDays: d,
    users, activity, retention, quiz, voice, referrals, content, economy,
  };
}