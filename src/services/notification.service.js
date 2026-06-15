import { prisma } from '../db/prisma.js';

// Creates ONE global notification for a newly published card. Every user picks
// it up via the notifications feed; unread state is per-user via their
// notificationsReadAt timestamp (no per-user fan-out).
export async function notifyNewCard(card) {
  try {
    await prisma.notification.create({
      data: {
        type: 'NEW_CARD',
        title: 'New card added',
        body: card.title,
        cardId: card.id,
      },
    });
  } catch (err) {
    console.error('[notify] failed to create notification', err.message);
  }
}