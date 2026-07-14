// Daily quiz cron job.
//
// Does two things, once a day:
//   1. Pre-generates today's 20-question quiz (so the FIRST user never waits on
//      the AI call). Lazy generation still works as a safety net if this job
//      doesn't run — this just warms it up.
//   2. Pushes a "today's quiz is live" notification to EVERY user — the daily
//      hook that pulls people back in.
//
// Run it from cron. Example (09:00 IST = 03:30 UTC):
//   30 3 * * * cd /home/ubuntu/huevixapp.backend && node scripts/quiz-daily.js >> /home/ubuntu/quiz-cron.log 2>&1
//
// Flags / env:
//   --no-notify        generate the quiz but DON'T push (use for manual re-runs
//                      so you don't double-notify users).
//
// Note on the "day": the quiz day rolls over at 00:00 UTC, which is 05:30 AM
// IST. So Indian users get a fresh quiz at ~5:30 AM and the morning push at
// 9 AM. (If you'd rather the day roll at IST midnight, say so and I'll switch
// the date logic in quiz.service.js.)

import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { getOrCreateTodayQuiz } from '../src/services/quiz.service.js';
import { pushToAll } from '../src/services/push.service.js';
import { SUPPORTED_LANGUAGES } from '../src/config/env.js';

const NOTIFY = !process.argv.includes('--no-notify');

function utcDayStart(d = new Date()) {
  const x = new Date(d);
  x.setUTCHours(0, 0, 0, 0);
  return x;
}

async function main() {
  // Generate for every live target language. Launch is English-only, so this is
  // usually a single quiz; reading the language registry means new languages are
  // picked up automatically with no code change.
  const langs = Object.keys(SUPPORTED_LANGUAGES);
  if (!langs.length) langs.push('en');

  let generated = 0;
  for (const lang of langs) {
    try {
      const quiz = await getOrCreateTodayQuiz(lang);
      const count = quiz?.questions?.length ?? 0;
      console.log(`[quiz-daily] ${lang}: quiz ${quiz?.id} ready (${count} questions)`);
      generated++;
    } catch (err) {
      console.error(`[quiz-daily] ${lang}: generation failed:`, err.message);
    }
  }

  if (!NOTIFY) {
    console.log('[quiz-daily] --no-notify set; skipping push');
    return;
  }
  if (generated === 0) {
    console.log('[quiz-daily] nothing generated; skipping push');
    return;
  }

  // Guard against double-notifying: only push if we haven't already sent a QUIZ
  // notification today (so a re-run of this job won't spam users).
  const already = await prisma.notification.findFirst({
    where: { type: 'QUIZ', createdAt: { gte: utcDayStart() } },
    select: { id: true },
  });
  if (already) {
    console.log('[quiz-daily] already notified today; skipping push');
    return;
  }

  const title = "Today's quiz is live 🎯";
  const body = 'Answer 20 questions, climb the leaderboard, and earn your shot at an interview!';
  try {
    // One global notification row (shows in the in-app feed)...
    await prisma.notification.create({ data: { type: 'QUIZ', title, body } });
    // ...plus a push to every device so closed apps get the nudge.
    await pushToAll({ title, body, data: { type: 'QUIZ' } });
    console.log('[quiz-daily] notified all users');
  } catch (err) {
    console.error('[quiz-daily] notify failed:', err.message);
  }
}

main()
  .catch((e) => {
    console.error('[quiz-daily] fatal:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
