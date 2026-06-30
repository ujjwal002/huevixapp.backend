// Creates a normal reviewer/test account AND grants full access
// (active subscription + call credits) for Google Play review.
//
// Usage (from the backend root):
//   node scripts/create-reviewer.js
// or with custom email/password:
//   node scripts/create-reviewer.js review@huevix.app MyPassword123
//
// Re-running is safe: it updates the existing account (and resets the password).

import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/utils/password.js';

const EMAIL = process.argv[2] || 'review@huevix.app';
const PASSWORD = process.argv[3] || 'HuevixReview2026!';

async function main() {
  const passwordHash = await hashPassword(PASSWORD);
  // ~10 years out so premium never expires during review.
  const farFuture = new Date(Date.now() + 10 * 365 * 24 * 60 * 60 * 1000);

  // Create the account (or reset its password if it already exists).
  const user = await prisma.user.upsert({
    where: { email: EMAIL },
    create: { email: EMAIL, passwordHash, name: 'Play Reviewer' },
    update: { passwordHash },
  });

  // Active subscription = premium unlocked.
  await prisma.subscription.upsert({
    where: { userId: user.id },
    create: {
      userId: user.id,
      plan: 'YEARLY',
      status: 'ACTIVE',
      provider: 'manual',
      currentPeriodEnd: farFuture,
    },
    update: {
      plan: 'YEARLY',
      status: 'ACTIVE',
      currentPeriodEnd: farFuture,
    },
  });

  // Plenty of call credits so every paid feature is reachable.
  await prisma.user.update({
    where: { id: user.id },
    data: {
      callSecondsBalance: 1000000,        // ~277 hours
      freeSpeakingCreditsRemaining: 1000,
    },
  });

  console.log('✅ Reviewer account ready — enter these in Play Console → App access:');
  console.log('   Email:    ' + EMAIL);
  console.log('   Password: ' + PASSWORD);
  console.log('   Premium:  active YEARLY subscription');
  console.log('   Credits:  1,000,000 call seconds + 1,000 free speaking credits');
}

main()
  .then(() => process.exit(0))
  .catch((e) => { console.error(e); process.exit(1); });