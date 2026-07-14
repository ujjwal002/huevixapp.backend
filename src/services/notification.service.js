import { prisma } from '../db/prisma.js';
import { pushToAll } from './push.service.js';

// Creates ONE global notification for a newly published card. Every user picks
// it up via the notifications feed; unread state is per-user via their
// notificationsReadAt timestamp (no per-user fan-out).
//
// Inshorts-style copy: the notification IS the story. The headline (card title)
// is the notification title, and a short snippet of the summary is the body, so
// it reads like a piece of news worth tapping — not a system "new card added"
// message.
export async function notifyNewCard(card) {
  try {
    const title = card.title;
    const body = snippet(card.body, 120);
    await prisma.notification.create({
      data: {
        type: 'NEW_CARD',
        title,
        body,
        cardId: card.id,
      },
    });
    // Also push to every device so closed apps get notified (fire-and-forget).
    pushToAll({
      title,
      body,
      image: card.imageUrl || undefined,
      data: { type: 'NEW_CARD', cardId: card.id },
    });
  } catch (err) {
    console.error('[notify] failed to create notification', err.message);
  }
}

// Trim a summary to a clean push-length snippet: collapse whitespace, cut at a
// word boundary near the limit, and add an ellipsis so it reads like a teaser.
function snippet(text, max = 120) {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…';
}

// Global notification announcing a newly-approved startup promo. Attractive
// copy to drive taps; opening the app surfaces the promo (it has feed priority).
export async function notifyPromoLive(promo) {
  try {
    await prisma.notification.create({
      data: {
        type: 'PROMO',
        title: `🚀 ${promo.startupName} just launched`,
        body: promo.title,
      },
    });
    pushToAll({
      title: `🚀 ${promo.startupName} just launched`,
      body: promo.title,
      data: { type: 'PROMO' },
    });
  } catch (err) {
    console.error('[notify] failed to create promo notification', err.message);
  }
}
