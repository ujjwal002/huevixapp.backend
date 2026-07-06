// Push pipeline diagnostic.
//
// Answers the question: "Admin posts an article but no push arrives — why?"
// It does NOT touch your app code. It reads your real device-token table and
// sends a real test push through Expo, then prints Expo's tickets + receipts so
// you can see EXACTLY where the pipeline breaks.
//
//   node scripts/test-push.js
//   node scripts/test-push.js "Custom title" "Custom body"
//
// Reading the output:
//   - 0 tokens in DB        -> the APP never registered. You're almost certainly
//                              on Expo Go (SDK 53+ can't get a push token on
//                              Android), a simulator, or permission was denied.
//                              Fix: install an `eas build` dev/production build
//                              on a real phone and log in once.
//   - tokens exist, tickets/receipts show errors:
//       InvalidCredentials   -> Expo has no FCM (Android) / APNs (iOS) key for
//                               your project. THIS is the usual "token exists
//                               but nothing ever arrives". Fix: `eas credentials`
//                               and upload the FCM key + APNs key.
//       MismatchSenderId     -> the google-services.json in the app doesn't
//                               match the FCM key uploaded to Expo. Re-upload.
//       DeviceNotRegistered  -> that token is dead (app uninstalled / reinstalled);
//                               it's auto-pruned. Re-open the app to re-register.
//   - tickets "ok" + receipts "ok" but still nothing on the phone -> the device
//     muted the channel, or you're looking at the wrong device. Check the phone's
//     per-app notification settings and the "Default" channel.

import 'dotenv/config';
import { Expo } from 'expo-server-sdk';
import { prisma } from '../src/db/prisma.js';

const title = process.argv[2] || "Hello guys !";
const body = process.argv[3] || "Please open the app and check if you have any new articles !";

const expo = new Expo(
  process.env.EXPO_ACCESS_TOKEN ? { accessToken: process.env.EXPO_ACCESS_TOKEN } : undefined
);

const mask = (t) => (t.length > 24 ? `${t.slice(0, 18)}…${t.slice(-6)}` : t);

async function main() {
  console.log('--- Push pipeline diagnostic ---\n');

  // 1) What's in the device-token table?
  const rows = await prisma.deviceToken.findMany({
    select: { token: true, platform: true, userId: true, lastSeenAt: true },
    orderBy: { lastSeenAt: 'desc' },
  });

  console.log(`Device tokens in DB: ${rows.length}`);
  if (rows.length === 0) {
    console.log(
      '\n⛔ No tokens registered. The server has nobody to push to — this is why\n' +
        '   "admin posts article" sends nothing. The problem is NOT your backend.\n' +
        '   The app must successfully call POST /notifications/devices on login.\n\n' +
        '   Most common causes (in order):\n' +
        '   1. Testing in Expo Go — Android push tokens were removed from Expo Go\n' +
        '      in SDK 53. Build a dev/prod client:  eas build --profile development\n' +
        '      then install it on a real phone and log in once.\n' +
        '   2. Simulator/emulator — real push tokens only exist on physical devices.\n' +
        '   3. Notification permission was denied on the device.\n'
    );
    return;
  }

  for (const r of rows) {
    const valid = Expo.isExpoPushToken(r.token) ? 'valid' : 'NOT A VALID EXPO TOKEN';
    console.log(
      `  • ${mask(r.token)}  [${r.platform || 'unknown'}]  user=${r.userId || 'anon'}  ${valid}  seen=${r.lastSeenAt.toISOString()}`
    );
  }

  const valid = [...new Set(rows.map((r) => r.token))].filter((t) => Expo.isExpoPushToken(t));
  if (valid.length === 0) {
    console.log(
      '\n⛔ Tokens exist but none look like Expo push tokens ("ExponentPushToken[...]").\n' +
        '   The app is registering the wrong value. Check getExpoPushTokenAsync().\n'
    );
    return;
  }

  // 2) Send a real push and collect tickets.
  console.log(`\nSending test push to ${valid.length} token(s)...`);
  const messages = valid.map((to) => ({
    to,
    sound: 'default',
    title,
    body,
    channelId: 'default', // must match the Android channel the app creates
    priority: 'high',
    data: { type: 'TEST' },
  }));

  const ticketIds = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      tickets.forEach((t, i) => {
        if (t.status === 'ok') {
          console.log(`  ✅ accepted: ${mask(chunk[i].to)}  id=${t.id}`);
          if (t.id) ticketIds.push(t.id);
        } else {
          console.log(
            `  ❌ rejected: ${mask(chunk[i].to)}  error=${t.details?.error || 'unknown'}  ${t.message || ''}`
          );
        }
      });
    } catch (err) {
      console.error('  ❌ send failed:', err.message);
    }
  }

  if (ticketIds.length === 0) {
    console.log('\nNo accepted tickets — see the rejection reasons above.');
    return;
  }

  // 3) Fetch delivery receipts. Expo accepts instantly but actual FCM/APNs
  //    delivery errors (bad credentials, dead device) only surface here.
  console.log('\nWaiting 4s for delivery receipts...');
  await new Promise((r) => setTimeout(r, 4000));

  for (const idChunk of expo.chunkPushNotificationReceiptIds(ticketIds)) {
    try {
      const receipts = await expo.getPushNotificationReceiptsAsync(idChunk);
      for (const [id, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'ok') {
          console.log(`  ✅ delivered: receipt ${id}`);
        } else {
          console.log(
            `  ❌ NOT delivered: receipt ${id}  error=${receipt.details?.error || 'unknown'}  ${receipt.message || ''}`
          );
        }
      }
    } catch (err) {
      console.error('  ❌ receipt fetch failed:', err.message);
    }
  }

  console.log('\nDone. If receipts are "delivered" but the phone shows nothing,\n' +
    'check the device\'s per-app notification settings and the "Default" channel.');
}

main()
  .catch((e) => {
    console.error('Diagnostic crashed:', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });