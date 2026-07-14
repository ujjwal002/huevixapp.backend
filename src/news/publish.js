/**
 * News pipeline — fetch (active provider) → dedupe → filter → summarize →
 * publish card (+ TTS audio, same as manual/AI cards).
 * Source-agnostic. Dedupe on Card.sourceUrl. No per-article push.
 */
import { prisma } from '../db/prisma.js';
import { getActiveProvider } from './registry.js';
import { summarizeArticle } from './summarize.js';
import { isAppropriate } from './filter.js';
import { synthesizeSpeech } from '../services/tts.service.js';

function countWords(s) {
  return (s || '').trim().split(/\s+/).filter(Boolean).length;
}

// Generate + attach TTS audio to a card — same behaviour as the card controller,
// so news articles get the listening feature like every other card.
async function generateAndAttachAudio(cardId, text, targetLanguage) {
  try {
    const { url } = await synthesizeSpeech({ text, targetLanguage });
    await prisma.card.update({
      where: { id: cardId },
      data: { audioUrl: url, audioStatus: 'READY' },
    });
  } catch (err) {
    console.error('[news:TTS] generation failed', err.message);
    await prisma.card.update({
      where: { id: cardId },
      data: { audioStatus: 'FAILED' },
    });
  }
}

async function alreadyPublishedUrls(urls) {
  if (!urls.length) return new Set();
  const rows = await prisma.card.findMany({
    where: { sourceUrl: { in: urls } },
    select: { sourceUrl: true },
  });
  return new Set(rows.map((r) => r.sourceUrl).filter(Boolean));
}

export async function runNewsBatch(opts = {}) {
  const {
    limit = 25,
    categories,
    country,
    language = 'en',
    targetLanguage = 'en',
    publish = true,
  } = opts;

  const provider = getActiveProvider();
  if (!provider) {
    console.error('[news] no provider configured (set NEWSDATA_API_KEY or NEWS_RSS_FEEDS)');
    return { fetched: 0, published: 0, skipped: 0, filtered: 0, provider: null, titles: [] };
  }

  const raw = await provider.fetch({ limit, categories, country, language });
  if (!raw.length) {
    return {
      fetched: 0,
      published: 0,
      skipped: 0,
      filtered: 0,
      provider: provider.name,
      titles: [],
    };
  }

  const seen = await alreadyPublishedUrls(raw.map((a) => a.url));
  const notSeen = raw.filter((a) => !seen.has(a.url));
  // Keep only articles that (a) pass the content filter AND (b) have an image —
  // an image-forward feed looks broken with imageless cards.
  const fresh = notSeen.filter((a) => isAppropriate(a) && a.imageUrl);
  const filtered = notSeen.length - fresh.length;

  const publishedTitles = [];
  let skipped = raw.length - notSeen.length;

  for (const article of fresh) {
    try {
      const summary = await summarizeArticle(article);
      if (!summary?.title || !summary?.body) {
        skipped++;
        continue;
      }
      const card = await prisma.card.create({
        data: {
          targetLanguage,
          topic: article.category || 'news',
          title: summary.title,
          body: summary.body,
          wordCount: countWords(summary.body),
          isPublished: publish,
          imageUrl: article.imageUrl || null,
          sourceUrl: article.url,
          // Attach the vocab glossary (complex words from the article) — same as
          // manual/AI cards, so users can learn vocabulary from the news.
          vocab: summary.vocab?.length
            ? {
                create: summary.vocab.map((v) => ({
                  nativeLanguage: 'hi',
                  term: v.term,
                  partOfSpeech: v.partOfSpeech,
                  meaning: v.meaning,
                  example: v.example,
                })),
              }
            : undefined,
        },
      });
      // Generate TTS audio just like manual/AI cards do.
      await generateAndAttachAudio(card.id, summary.body, targetLanguage);
      publishedTitles.push(card.title);
    } catch (e) {
      console.error('[news] failed to publish article:', article.url, e.message);
      skipped++;
    }
  }

  return {
    fetched: raw.length,
    published: publishedTitles.length,
    skipped,
    filtered,
    provider: provider.name,
    titles: publishedTitles,
  };
}
