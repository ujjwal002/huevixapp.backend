import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';

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