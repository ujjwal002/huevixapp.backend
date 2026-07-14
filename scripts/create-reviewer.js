// Creates (or resets) a Play Store reviewer/test account with full access
// (active subscription + call credits) so Google Play reviewers can reach every
// paid feature during review.
//
// SECURITY:
//   * The password is REQUIRED and is never hardcoded. Provide it via the
//     REVIEWER_PASSWORD env var (preferred — it stays out of shell history and
//     the process list) or as the 2nd CLI argument. A public default password
//     on a fully-privileged account is a standing backdoor, so there is none.
//   * Running against production is blocked BY DEFAULT, because this mints a
//     long-lived, fully-privileged account. Set ALLOW_PROD_REVIEWER=1 to
//     override when you genuinely need a prod login for Play review.
//
// USAGE:
//   REVIEWER_PASSWORD='<strong-password>' node scripts/create-reviewer.js
//   node scripts/create-reviewer.js review@huevix.app '<strong-password>'
//   ALLOW_PROD_REVIEWER=1 REVIEWER_PASSWORD='...' NODE_ENV=production \
//     node scripts/create-reviewer.js
//
// Re-running is safe: it updates the existing account (and resets the password).
// REMINDER: delete or disable this account once Play review is approved.

import { prisma } from '../src/db/prisma.js';
import { hashPassword } from '../src/utils/password.js';

const EMAIL = process.argv[2] || 'review@huevix.app';
// Password: env var first (doesn't leak into shell history / `ps`), then argv.
// NEVER a hardcoded default.
const PASSWORD = process.env.REVIEWER_PASSWORD || process.argv[3] || '';

// Privileged account => stricter floor than the app's normal 8-char minimum.
const MIN_PASSWORD_LEN = 12;

function fail(msg) {
  console.error(`\u2717 ${msg}`);
  process.exit(1);
}

// --- Guards run BEFORE any DB work so a misuse can't half-create the account --

// Guard rail, not a wall: block an ACCIDENTAL prod run, allow a DELIBERATE one.
if (process.env.NODE_ENV === 'production' && process.env.ALLOW_PROD_REVIEWER !== '1') {
  fail(
    'Refusing to create a fully-privileged reviewer account in production.\n' +
      '  This account has a ~10-year subscription and 1,000,000 call credits.\n' +
      '  If you truly need it for Play review, re-run with ALLOW_PROD_REVIEWER=1\n' +
      '  and delete the account once review is approved.'
  );
}

if (!PASSWORD) {
  fail(
    'A password is required (no default is allowed).\n' +
      "  Preferred: REVIEWER_PASSWORD='<strong-password>' node scripts/create-reviewer.js\n" +
      "  Or:        node scripts/create-reviewer.js <email> '<strong-password>'"
  );
}
if (PASSWORD.length < MIN_PASSWORD_LEN) {
  fail(
    `Password too short: use at least ${MIN_PASSWORD_LEN} characters for this privileged account.`
  );
}

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
      callSecondsBalance: 1000000, // ~277 hours
      freeSpeakingCreditsRemaining: 1000,
    },
  });

  // Deliberately DO NOT echo the password — you already chose it, and printing
  // it here would drop the secret into terminal scrollback / CI logs.
  console.log('\u2705 Reviewer account ready — enter these in Play Console \u2192 App access:');
  console.log('   Email:    ' + EMAIL);
  console.log('   Password: (the one you provided)');
  console.log('   Premium:  active YEARLY subscription');
  console.log('   Credits:  1,000,000 call seconds + 1,000 free speaking credits');
  console.log('   Reminder: delete or disable this account once review is approved.');
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
