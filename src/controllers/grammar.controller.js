import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

export const listLessons = asyncHandler(async (_req, res) => {
  const lessons = await prisma.grammarLesson.findMany({
    orderBy: { order: 'asc' },
    select: { id: true, level: true, order: true, title: true, summary: true },
  });
  res.json({ lessons });
});

export const getLesson = asyncHandler(async (req, res) => {
  const lesson = await prisma.grammarLesson.findUnique({ where: { id: req.params.id } });
  if (!lesson) throw ApiError.notFound('Lesson not found');
  res.json(lesson);
});
