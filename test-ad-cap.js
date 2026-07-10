// test-ad-cap.js
import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const BASE = process.env.TEST_BASE || 'http://localhost:4000/api/v1';
const EMAIL = 'learner@huevix.app';
const PASSWORD = 'Password123';

const claim = (token) =>
  fetch(`${BASE}/ads/reward`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => ({})) }));

async function main() {
  const { accessToken, user } = await (await fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })).json();

  const stats = await (await fetch(`${BASE}/users/me/stats`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })).json();
  if (stats.entitlement?.subscriptionActive) throw new Error('Use a non-subscribed user.');
  const cap = stats.entitlement?.maxAdCreditsPerDay ?? 3;

  // Deterministic start: 0 credits, 0 granted today, dated today (so it won't reset mid-test).
  await prisma.user.update({
    where: { id: user.id },
    data: { adCreditsRemaining: 0, adCreditsGrantedToday: 0, adCreditsGrantedDate: new Date() },
  });

  const granted = [];
  for (let i = 0; i < cap; i++) granted.push(await claim(accessToken)); // up to the cap
  const over = await claim(accessToken);                               // one past the cap

  // Simulate the user SPENDING all their ad credits — the old bug's trigger.
  await prisma.user.update({ where: { id: user.id }, data: { adCreditsRemaining: 0 } });
  const afterSpend = await claim(accessToken);                         // must STILL be denied

  const allGranted = granted.every((g) => g.body?.granted === true);
  const overDenied = over.body?.granted === false && over.body?.reason === 'DAILY_AD_LIMIT';
  const stillDenied = afterSpend.body?.granted === false && afterSpend.body?.reason === 'DAILY_AD_LIMIT';

  console.log(`first ${cap} claims granted:`, allGranted);
  console.log('claim past cap denied:', overDenied);
  console.log('claim after spending all credits denied:', stillDenied);
  console.log(allGranted && overDenied && stillDenied
    ? '\nPASS — daily cap holds even after spending (true per-day cap)'
    : '\nFAIL — cap bypassable; check grantAdCredit / adCreditsGrantedToday');
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());