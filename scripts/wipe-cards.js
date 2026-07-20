/**
 * Wipe ALL cards (articles) so a fresh current-affairs batch can be generated.
 * Vocab entries, saved cards, reading progress and speaking attempts are
 * removed automatically via onDelete: Cascade. Card images/audio already
 * uploaded to storage are left behind (harmless orphans).
 *
 * Usage:
 *   node scripts/wipe-cards.js               # DRY RUN — shows counts, deletes nothing
 *   node scripts/wipe-cards.js --yes         # actually delete every card
 *   node scripts/wipe-cards.js --yes --quiz  # also delete TODAY'S quiz, so the next
 *                                            # open regenerates it from the fresh cards
 */
import 'dotenv/config';
import { prisma } from '../src/db/prisma.js';
import { startOfUtcDay } from '../src/utils/dates.js';

const yes = process.argv.includes('--yes');
const alsoQuiz = process.argv.includes('--quiz');

async function main() {
  const cards = await prisma.card.count();
  const vocab = await prisma.vocabEntry.count();
  console.log(`[wipe] found ${cards} cards and ${vocab} vocab entries (saves/progress cascade too)`);

  if (!yes) {
    console.log('[wipe] DRY RUN — nothing deleted. Re-run with --yes to actually delete.');
    return;
  }

  const r = await prisma.card.deleteMany({});
  console.log(`[wipe] deleted ${r.count} cards (vocab, saves, progress removed via cascade)`);

  if (alsoQuiz) {
    const q = await prisma.dailyQuiz.deleteMany({ where: { date: startOfUtcDay() } });
    console.log(`[wipe] deleted ${q.count} quiz(es) for today — next open rebuilds from fresh cards`);
  }
}

main()
  .catch((e) => {
    console.error('[wipe] fatal', e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());