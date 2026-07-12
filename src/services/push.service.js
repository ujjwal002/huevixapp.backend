import { Expo } from 'expo-server-sdk';
import { prisma } from '../db/prisma.js';

// EXPO_ACCESS_TOKEN is optional — only needed if you've enabled "push security"
// in your Expo account. Leaving it unset works for standard setups.
const expo = new Expo(
  process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : undefined
);

// Send a notification to a set of Expo push tokens. Invalid/dead tokens are
// dropped from the database so the list stays clean over time.
async function sendToTokens(tokens, { title, body, data, image }) {
  const valid = [...new Set(tokens)].filter((t) => Expo.isExpoPushToken(t));
  if (!valid.length) return;

  const messages = valid.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    data: data || {},
    channelId: 'default', // must match the Android channel the app creates
    priority: 'high',
    // Rich (big-picture) notification image when provided. Expo maps richContent
    // to a large image on Android; also mirrored into data so the app can render
    // it in the foreground / notifications feed.
    ...(image ? { richContent: { image }, data: { ...(data || {}), image } } : {}),
  }));

  const chunks = expo.chunkPushNotifications(messages);
  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((ticket, i) => {
        if (ticket.status === 'error' && ticket.details?.error === 'DeviceNotRegistered') {
          // The app was uninstalled / token revoked — remove it.
          prisma.deviceToken.deleteMany({ where: { token: chunk[i].to } }).catch(() => {});
        }
      });
    } catch (err) {
      console.error('[push] send chunk failed', err.message);
    }
  }
}

// Broadcast to every registered device. Matches the app's GLOBAL notifications
// (new card / promo) — one row, everyone gets pinged.
//
// Paginated so memory stays flat no matter how many devices are registered: we
// page through deviceToken by primary key and send each page as we go, instead
// of loading the entire token table into memory at once. CURSOR (not offset)
// pagination is deliberate — sendToTokens asynchronously deletes dead
// (DeviceNotRegistered) tokens, and a cursor keyed on the last id we saw can't
// skip rows when earlier rows disappear mid-run. Each page is sent via the same
// sendToTokens worker, whose per-chunk try/catch keeps one failing batch from
// aborting the rest.
const BROADCAST_PAGE_SIZE = 1000;

export async function pushToAll({ title, body, data, image }) {
  try {
    let cursor = null;
    for (;;) {
      const rows = await prisma.deviceToken.findMany({
        select: { id: true, token: true },
        orderBy: { id: 'asc' },
        take: BROADCAST_PAGE_SIZE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;

      await sendToTokens(
        rows.map((r) => r.token),
        { title, body, data, image }
      );

      cursor = rows[rows.length - 1].id;
      if (rows.length < BROADCAST_PAGE_SIZE) break; // last (partial) page
    }
  } catch (err) {
    console.error('[push] pushToAll failed', err.message);
  }
}

// Send to a single user's devices. Not used yet — here for future per-user
// pushes (e.g. an incoming-call invite).
export async function pushToUser(userId, { title, body, data }) {
  try {
    const rows = await prisma.deviceToken.findMany({
      where: { userId },
      select: { token: true },
    });
    await sendToTokens(
      rows.map((r) => r.token),
      { title, body, data }
    );
  } catch (err) {
    console.error('[push] pushToUser failed', err.message);
  }
}