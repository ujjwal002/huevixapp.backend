import { Expo } from 'expo-server-sdk';
import { prisma } from '../db/prisma.js';

// EXPO_ACCESS_TOKEN is optional — only needed if you've enabled "push security"
// in your Expo account. Leaving it unset works for standard setups.
const expo = new Expo(
  process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : undefined
);

// Send a notification to a set of Expo push tokens. Invalid/dead tokens are
// dropped from the database so the list stays clean over time.
async function sendToTokens(tokens, { title, body, data }) {
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
export async function pushToAll({ title, body, data }) {
  try {
    const rows = await prisma.deviceToken.findMany({ select: { token: true } });
    await sendToTokens(
      rows.map((r) => r.token),
      { title, body, data }
    );
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