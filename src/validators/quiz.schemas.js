import { z } from 'zod';

// Shapes match your validate() middleware: { body?, query?, params? }.

export const submitAnswerSchema = {
  body: z.object({
    questionId: z.string().min(1),
    chosenIndex: z.number().int().min(0).max(9),
  }),
};

export const leaderboardQuerySchema = {
  query: z.object({
    limit: z.coerce.number().int().min(1).max(100).optional().default(20),
  }),
};

// The top scorer accepts the interview / work-from-home opportunity.
export const winnerAcceptSchema = {
  body: z.object({
    contactPhone: z.string().min(7).max(20),
    preferredRole: z.string().max(120).optional(),
    note: z.string().max(500).optional(),
  }),
};

export const adminGenerateSchema = {
  body: z.object({
    targetLanguage: z.string().min(2).max(8).optional().default('en'),
  }),
};

export const adminSelectWinnerSchema = {
  body: z.object({
    period: z.string().regex(/^\d{4}-\d{2}$/, 'period must be "YYYY-MM"'),
    note: z.string().max(500).optional(),
  }),
};

export const adminWinnerStatusSchema = {
  body: z.object({
    status: z.enum(['OFFERED', 'ACCEPTED', 'CLOSED', 'CANCELED']),
  }),
};

export const idParam = {
  params: z.object({ id: z.string().min(1) }),
};
