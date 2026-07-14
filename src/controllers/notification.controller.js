import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

// GET /notifications — recent notifications + how many are unread for this user.
export const listNotifications = asyncHandler(async (req, res) => {
  const readAt = req.user.notificationsReadAt;

  const [items, unreadCount] = await Promise.all([
    prisma.notification.findMany({ orderBy: { createdAt: 'desc' }, take: 30 }),
    prisma.notification.count({ where: readAt ? { createdAt: { gt: readAt } } : {} }),
  ]);

  res.json({
    unreadCount,
    items: items.map((n) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      cardId: n.cardId,
      createdAt: n.createdAt,
      unread: !readAt || n.createdAt > readAt,
    })),
  });
});

// POST /notifications/read — mark everything up to now as read.
export const markNotificationsRead = asyncHandler(async (req, res) => {
  await prisma.user.update({
    where: { id: req.user.id },
    data: { notificationsReadAt: new Date() },
  });
  res.json({ success: true });
});

// POST /notifications/devices — register (or refresh) this device's push token.
// Upsert by token so re-registering the same device just bumps lastSeenAt and
// re-links it to the current user.
export const registerDevice = asyncHandler(async (req, res) => {
  const { token, platform } = req.body || {};
  if (!token || typeof token !== 'string') {
    throw ApiError.badRequest('A device push token is required');
  }
  await prisma.deviceToken.upsert({
    where: { token },
    create: { token, platform: platform || null, userId: req.user.id, lastSeenAt: new Date() },
    update: { platform: platform || null, userId: req.user.id, lastSeenAt: new Date() },
  });
  res.json({ success: true });
});

// DELETE /notifications/devices — drop this device's token (call on logout).
// Scoped to the caller's own userId so one user can't unregister another's
// device by supplying their token value.
export const unregisterDevice = asyncHandler(async (req, res) => {
  const { token } = req.body || {};
  if (token) await prisma.deviceToken.deleteMany({ where: { token, userId: req.user.id } });
  res.json({ success: true });
});
