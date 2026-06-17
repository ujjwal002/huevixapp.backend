// test-double-spend.js
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.TEST_BASE || 'http://localhost:4000/api/v1';
const EMAIL = 'learner@lingoshorts.app';
const PASSWORD = 'Password123';
const N = 5; // concurrent requests (keep <= 10 to stay under the rate limit)

async function main() {
  // 1. Log in -> token + user id.
  const login = await (await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })).json();
  const { accessToken, user } = login;

  // Make sure this user isn't a subscriber, or the trial path won't run.
  const stats = await (await fetch(`${BASE}/users/me/stats`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })).json();
  if (stats.entitlement?.subscriptionActive) {
    throw new Error('User has an ACTIVE subscription — use a non-subscribed user.');
  }

  // 2. Force the state under test: exactly 1 free credit, no ad credits.
  await prisma.user.update({
    where: { id: user.id },
    data: { freeSpeakingCreditsRemaining: 1, adCreditsRemaining: 0 },
  });

  // 3. Grab a published card.
  const feed = await (await fetch(`${BASE}/cards/feed`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })).json();
  const cardId = feed.items?.[0]?.id;
  if (!cardId) throw new Error('No published card in the feed — seed one first.');

  // 4. Fire N requests concurrently with a dummy audio clip.
  const fire = () => {
    const fd = new FormData();
    fd.append('audio', new Blob([Buffer.from('dummy')], { type: 'audio/webm' }), 'clip.webm');
    return fetch(`${BASE}/cards/${cardId}/speak`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}` },
      body: fd,
    }).then(async (r) => ({ status: r.status }));
  };
  const results = await Promise.all(Array.from({ length: N }, fire));

  // 5. Tally + read the counter back from the DB.
  const ok = results.filter((r) => r.status === 201).length;
  const paywall = results.filter((r) => r.status === 402).length;
  const after = await prisma.user.findUnique({
    where: { id: user.id },
    select: { freeSpeakingCreditsRemaining: true },
  });

  console.log('statuses:', results.map((r) => r.status).join(', '));
  console.log(`success (201): ${ok}   paywall (402): ${paywall}`);
  console.log(`credits after: ${after.freeSpeakingCreditsRemaining}`);
  const pass = ok === 1 && paywall === N - 1 && after.freeSpeakingCreditsRemaining === 0;
  console.log(pass ? '\nPASS — one success, counter at 0 (never negative)'
                   : '\nFAIL — race not contained; check reserveCredit');
}

main().catch((e) => { console.error(e); process.exitCode = 1; })
      .finally(() => prisma.$disconnect());