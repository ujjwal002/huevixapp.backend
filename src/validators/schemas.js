import { z } from 'zod';
import {
  SUPPORTED_LANGUAGES,
  SUPPORTED_NATIVE_LANGUAGES,
} from '../config/env.js';

const targetEnum = z.enum(Object.keys(SUPPORTED_LANGUAGES));
const nativeEnum = z.enum(Object.keys(SUPPORTED_NATIVE_LANGUAGES));
const levelEnum = z.enum(['BEGINNER', 'INTERMEDIATE', 'ADVANCED']);

// Normalize email before validating so "User@X.com " and "user@x.com" can't
// become two distinct accounts and login stays case-insensitive.
const emailField = z.preprocess(
  (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v),
  z.string().email()
);

// zod's .url() only checks that new URL() parses, which ACCEPTS javascript: and
// data: schemes — dangerous for values we store and render to other users.
// httpUrl: strictly absolute http(s). safeLinkUrl: http(s) OR an in-app
// root-relative path ("/checkout"), but never "//host" (protocol-relative),
// javascript:, or data:.
const httpUrl = z
  .string()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), { message: 'Must be an http(s) URL' });
const safeLinkUrl = z
  .string()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v) || /^\/(?!\/)/.test(v), {
    message: 'URL must be http(s) or a root-relative path (not //, javascript:, or data:)',
  });

export const registerSchema = {
  body: z.object({
    email: emailField,
    password: z.string().min(8).max(128),
    name: z.string().min(1).max(80).optional(),
    nativeLanguage: nativeEnum.optional(),
    targetLanguage: targetEnum.optional(),
  }),
};

export const loginSchema = {
  body: z.object({
    email: emailField,
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

// News → article: admin pastes the article text + uploads an image (multipart).
export const createArticleSchema = {
  body: z.object({
    text: z.string().min(40).max(20000),
    title: z.string().min(1).max(120).optional(),
    level: levelEnum.optional(),
    targetLanguage: targetEnum.optional(),
    nativeLanguage: nativeEnum.optional(),
    sourceUrl: z.string().max(500).optional(),
    publish: z.union([z.boolean(), z.string()]).optional(),
  }),
};


// ---- Startup promos (paid user ads) ----
export const createPromoSchema = {
  body: z.object({
    startupName: z.string().min(1).max(60),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(280),
    ctaUrl: httpUrl,
    ctaText: z.string().min(1).max(24).optional(),
    imageUrl: z.union([httpUrl, z.literal('')]).optional(),
    days: z.coerce.number().int().min(1).max(30).default(1),
  }),
};

export const confirmPromoSchema = {
  params: z.object({ id: z.string().min(8) }),
  body: z.object({
    paymentId: z.string().min(1),
    signature: z.string().min(1),
  }),
};

export const promoIdParam = {
  params: z.object({ id: z.string().min(8) }),
};

export const rejectPromoSchema = {
  params: z.object({ id: z.string().min(8) }),
  body: z.object({ reason: z.string().max(280).optional() }),
};

// ---- Sponsored house ads (admin-managed) ----
// ctaUrl uses safeLinkUrl because a sponsored CTA may be an in-app path like
// "/checkout?plan=MONTHLY" (a leading "/" opens in-app; a full URL opens the
// browser). javascript:/data:/protocol-relative are rejected.
export const sponsoredIdParam = {
  params: z.object({ id: z.string().min(1) }),
};

// ---- App settings (admin) ----
export const updateSettingsSchema = {
  body: z
    .object({
      adsEnabled: z.boolean().optional(),
      adEveryNCards: z.coerce.number().int().min(1).max(50).optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No settings to update' }),
};

export const createSponsoredSchema = {
  body: z.object({
    advertiser: z.string().min(1).max(80),
    title: z.string().min(1).max(120),
    body: z.string().min(1).max(280),
    ctaText: z.string().min(1).max(24).optional(),
    ctaUrl: safeLinkUrl,
    imageUrl: z.union([safeLinkUrl, z.literal('')]).optional(),
    isActive: z.boolean().optional(),
  }),
};

export const updateSponsoredSchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      advertiser: z.string().min(1).max(80).optional(),
      title: z.string().min(1).max(120).optional(),
      body: z.string().min(1).max(280).optional(),
      ctaText: z.string().min(1).max(24).optional(),
      ctaUrl: safeLinkUrl.optional(),
      imageUrl: z.union([safeLinkUrl, z.literal('')]).optional(),
      isActive: z.boolean().optional(),
    })
    .refine((o) => Object.keys(o).length > 0, { message: 'No fields to update' }),
};