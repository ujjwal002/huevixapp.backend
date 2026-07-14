import { prisma } from '../db/prisma.js';

// Single-row "AppSettings" accessor. Read by hot, public endpoints (/meta,
// /sponsored), so the value is cached in-process with a short TTL — a flip from
// the admin shows up locally at once (we refresh the cache on write) and within
// TTL on any other instance.
const TTL_MS = 30_000;
const SINGLETON_ID = 'singleton';

let cache = null;
let cachedAt = 0;

export async function getAppSettings() {
  if (cache && Date.now() - cachedAt < TTL_MS) return cache;

  // Reads are a plain SELECT once the row exists; only the very first read
  // creates it (upsert tolerates a concurrent first-read race).
  let row = await prisma.appSettings.findUnique({ where: { id: SINGLETON_ID } });
  if (!row) {
    row = await prisma.appSettings.upsert({
      where: { id: SINGLETON_ID },
      update: {},
      create: { id: SINGLETON_ID },
    });
  }
  cache = row;
  cachedAt = Date.now();
  return row;
}

export async function updateAppSettings(patch) {
  const row = await prisma.appSettings.upsert({
    where: { id: SINGLETON_ID },
    update: patch,
    create: { id: SINGLETON_ID, ...patch },
  });
  cache = row;
  cachedAt = Date.now();
  return row;
}
