import { z } from 'zod';
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_NATIVE_LANGUAGES,
} from '../config/env.js';

const targetEnum = z.enum(Object.keys(SUPPORTED_LANGUAGES));
const nativeEnum = z.enum(Object.keys(SUPPORTED_NATIVE_LANGUAGES));
const levelEnum = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);

export const registerSchema = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).max(128),
    name: z.string().min(1).max(80).optional(),
    nativeLanguage: nativeEnum.optional(),
    targetLanguage: targetEnum.optional(),
  }),
};

export const loginSchema = {
  body: z.object({
    email: z.string().email(),
    password: z.string().min(1),
  }),
};

export const refreshSchema = {
  body: z.object({ refreshToken: z.string().min(10) }),
};

export const updateMeSchema = {
  body: z
    .object({
      name: z.string().min(1).max(80).optional(),
      nativeLanguage: nativeEnum.optional(),
      targetLanguage: targetEnum.optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
};

export const feedQuerySchema = {
  query: z.object({
    level: levelEnum.optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(20).default(10),
  }),
};

export const cardIdParam = {
  params: z.object({ id: z.string().uuid() }),
};

export const completeCardSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    readDone: z.boolean().optional(),
    listenDone: z.boolean().optional(),
  }),
};

export const createCardSchema = {
  body: z.object({
    targetLanguage: targetEnum,
    level: levelEnum.default('BEGINNER'),
    topic: z.string().max(60).optional(),
    title: z.string().min(1).max(120),
    body: z.string().min(20).max(2000),
    publish: z.boolean().default(true),
    vocab: z
      .array(
        z.object({
          nativeLanguage: nativeEnum,
          term: z.string().min(1),
          partOfSpeech: z.string().optional(),
          meaning: z.string().min(1),
          example: z.string().optional(),
        })
      )
      .optional(),
  }),
};

export const generateCardSchema = {
  body: z.object({
    targetLanguage: targetEnum,
    nativeLanguage: nativeEnum,
    level: levelEnum.default('BEGINNER'),
    topic: z.string().max(60).optional(),
    publish: z.boolean().default(true),
  }),
};

export const checkoutSchema = {
  body: z.object({ plan: z.enum(['MONTHLY', 'YEARLY']) }),
};

export const verifyPaymentSchema = {
  body: z.object({
    orderId: z.string().min(1),
    paymentId: z.string().min(1),
    signature: z.string().min(1),
  }),
};
