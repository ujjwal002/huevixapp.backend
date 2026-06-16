import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

const prisma = new PrismaClient();
const lessons = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'prisma', 'grammar-lessons.json'), 'utf8'));
const MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

async function generate(l) {
  const prompt = `You are an expert English teacher writing for a Hindi-speaking learner.
Topic: "${l.title}" (level: ${l.level}).
Write a clear, detailed, friendly lesson. Return a JSON object:
{
 "explanation": "several short paragraphs separated by \\n\\n, explaining the rules simply; add a Hindi clarification in Devanagari where helpful",
 "examples": ["6-8 example sentences; show wrong vs right where useful, e.g. '❌ He go ➜ ✅ He goes'"],
 "tips": ["3-5 short practical tips or common mistakes"]
}
Return ONLY the JSON object.`;
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: prompt }], response_format: { type: 'json_object' }, temperature: 0.4 }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || 'OpenAI error');
  return JSON.parse(data.choices?.[0]?.message?.content || '{}');
}

async function main() {
  for (const l of lessons) {
    const existing = await prisma.grammarLesson.findUnique({ where: { title: l.title } });
    if (existing?.explanation) { console.log(`✓ ${l.title} (done)`); continue; }
    console.log(`Generating: ${l.title}…`);
    let c;
    try { c = await generate(l); } catch (e) { console.error(`Failed ${l.title}: ${e.message}`); continue; }
    const data = { level: l.level, order: l.order, summary: l.summary, explanation: c.explanation || '', examples: c.examples || [], tips: c.tips || [] };
    await prisma.grammarLesson.upsert({ where: { title: l.title }, create: { title: l.title, ...data }, update: data });
    console.log(`✓ ${l.title}`);
    await new Promise((r) => setTimeout(r, 300));
  }
  console.log('🎉 Grammar seeding complete.');
}
main().catch(console.error).finally(() => prisma.$disconnect());