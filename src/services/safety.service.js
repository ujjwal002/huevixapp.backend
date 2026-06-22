import { prisma } from '../db/prisma.js';

// All user ids this user must NOT be matched with: everyone they blocked PLUS
// everyone who blocked them (blocking is one-directional in storage but must be
// enforced both ways at match time). Returned as a Set for O(1) filtering in
// the matchmaker. One query per "find partner".
export async function getBlockedUserIds(userId) {
  const rows = await prisma.block.findMany({
    where: { OR: [{ userId }, { blockedUserId: userId }] },
    select: { userId: true, blockedUserId: true },
  });
  const set = new Set();
  for (const r of rows) {
    set.add(r.userId === userId ? r.blockedUserId : r.userId);
  }
  return set;
}

// Block a user (idempotent). A self-block is a no-op.
export async function blockUser(userId, blockedUserId) {
  if (!blockedUserId || userId === blockedUserId) return null;
  return prisma.block.upsert({
    where: { userId_blockedUserId: { userId, blockedUserId } },
    update: {},
    create: { userId, blockedUserId },
  });
}

export async function unblockUser(userId, blockedUserId) {
  await prisma.block.deleteMany({ where: { userId, blockedUserId } });
}

// File a report. Reporting someone implies you don't want to see them again, so
// we also block them — that immediately removes them from your match pool.
export async function createReport({ reporterId, reportedUserId, callId, reason, note }) {
  const report = await prisma.report.create({
    data: {
      reporterId,
      reportedUserId,
      callId: callId || null,
      reason,
      note: note || null,
    },
    select: { id: true },
  });
  await blockUser(reporterId, reportedUserId).catch(() => {});
  return report;
}
