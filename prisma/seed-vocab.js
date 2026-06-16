import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const prisma = new PrismaClient();
const words = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'prisma', 'vocab-words.json'), 'utf8'));
const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

async function enrichLadder(batch) {
  const list = batch.map((w) => w.word).join(', ');
  const prompt = `You are helping a Hindi-speaking beginner learn English.
For each English word below, return a JSON object: {"items":[{"word","partOfSpeech","meaning","translation","example"}]}
- "meaning": a very simple English definition, max 12 words.
- "translation": the Hindi meaning in Devanagari script.
- "example": one short, simple example sentence using the word.
Words: ${list}
Return ONLY the JSON object.`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI error');
  const obj = JSON.parse(data.choices?.[0]?.message?.content || '{}');
  return obj.items || [];
}

async function main() {
  const ladders = {};
  for (const w of words) (ladders[w.ladder] ||= []).push(w);

  for (const num of Object.keys(ladders).map(Number).sort((a, b) => a - b)) {
    const batch = ladders[num];
    const done = await prisma.vocabWord.count({
      where: { word: { in: batch.map((b) => b.word) }, translation: { not: null } },
    });
    if (done === batch.length) { console.log(`Ladder ${num}: already done ✓`); continue; }

    console.log(`Ladder ${num}: generating explanations for ${batch.length} words…`);
    let enriched = [];
    try { enriched = await enrichLadder(batch); }
    catch (e) { console.error(`Ladder ${num} failed: ${e.message} — will retry on next run`); continue; }

    const byWord = new Map(enriched.map((e) => [String(e.word || '').toLowerCase(), e]));
    for (const w of batch) {
      const e = byWord.get(w.word) || {};
      const data = {
        rank: w.rank, ladder: w.ladder,
        partOfSpeech: e.partOfSpeech || null,
        meaning: e.meaning || w.word,
        translation: e.translation || null,
        example: e.example || null,
      };
      await prisma.vocabWord.upsert({ where: { word: w.word }, create: { word: w.word, ...data }, update: data });
    }
    console.log(`Ladder ${num}: done ✓`);
    await new Promise((r) => setTimeout(r, 400)); // gentle pacing
  }
  console.log('🎉 Vocab seeding complete.');
}

main().catch(console.error).finally(() => prisma.$disconnect());