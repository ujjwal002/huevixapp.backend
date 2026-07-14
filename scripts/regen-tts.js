/**
 * Regenerate TTS audio for cards left without it (audioStatus PENDING/FAILED or
 * null audioUrl) — e.g. after the storage-URL fix nulled audio that had been
 * written to LOCAL disk before the S3 switch. The card body text is intact, so
 * we simply re-synthesize; with STORAGE_DRIVER=s3 the new mp3 lands in S3 with a
 * correct URL. Old local mp3s become orphaned (harmless).
 *
 * Sequential with a small delay to stay under TTS provider rate limits.
 * Resumable: only touches cards still missing audio, so you can re-run any time
 * (e.g. after a few FAILs, or to process in batches with --limit).
 *
 *   node scripts/regen-tts.js              # regenerate all that need it
 *   node scripts/regen-tts.js --limit 20   # cap this run (optional; costs API $)
 *
 * REQUIRES prod env: MOCK_EXTERNAL=false, a TTS provider key (ElevenLabs/Azure),
 * STORAGE_DRIVER=s3 (so output goes to the bucket).
 */
import { prisma } from '../src/db/prisma.js';
import { synthesizeSpeech } from '../src/services/tts.service.js';

const i = process.argv.indexOf('--limit');
const LIMIT = i !== -1 ? parseInt(process.argv[i + 1], 10) : Infinity;
const DELAY_MS = 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const cards = await prisma.card.findMany({
    where: { OR: [{ audioUrl: null }, { audioStatus: 'PENDING' }, { audioStatus: 'FAILED' }] },
    select: { id: true, body: true, targetLanguage: true, title: true },
    orderBy: { createdAt: 'desc' },
  });

  const todo = Number.isFinite(LIMIT) ? cards.slice(0, LIMIT) : cards;
  console.log(`[regen-tts] ${cards.length} card(s) need audio; processing ${todo.length}\n`);

  let ok = 0, failed = 0;
  for (const [n, c] of todo.entries()) {
    const tag = `(${n + 1}/${todo.length}) ${c.id} "${(c.title || '').slice(0, 40)}"`;
    try {
      const { url } = await synthesizeSpeech({ text: c.body, targetLanguage: c.targetLanguage });
      await prisma.card.update({ where: { id: c.id }, data: { audioUrl: url, audioStatus: 'READY' } });
      console.log(`  OK   ${tag}`);
      ok++;
    } catch (e) {
      await prisma.card.update({ where: { id: c.id }, data: { audioStatus: 'FAILED' } }).catch(() => {});
      console.log(`  FAIL ${tag} — ${e.message}`);
      failed++;
    }
    await sleep(DELAY_MS);
  }

  console.log(`\n----- summary -----`);
  console.log(`regenerated : ${ok}`);
  console.log(`failed      : ${failed} (re-run to retry)`);
  console.log(`remaining   : ${cards.length - ok}`);
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('[regen-tts] failed:', e);
  await prisma.$disconnect();
  process.exit(1);
});