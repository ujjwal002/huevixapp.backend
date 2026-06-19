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

// Admin-written article (multipart: a hero image file + these text fields). The
// admin authors everything; no AI. `vocab` is sent as a JSON string in the
// form and parsed in the controller against adminArticleVocabSchema below.
export const createAdminArticleSchema = {
  body: z.object({
    title: z.string().min(1).max(120),
    body: z.string().min(20).max(2000),
    targetLanguage: targetEnum.optional(),
    nativeLanguage: nativeEnum.optional(),
    level: levelEnum.optional(),
    topic: z.string().max(60).optional(),
    sourceUrl: z.string().max(500).optional(),
    publish: z.union([z.boolean(), z.string()]).optional(),
    vocab: z.string().max(10000).optional(), // JSON string; parsed in controller
  }),
};

// Shape of each vocab entry the admin supplies. Meanings are written in the
// article's nativeLanguage and applied to every entry (same convention as the
// AI news flow), so individual entries don't carry their own language.
export const adminArticleVocabSchema = z
  .array(
    z.object({
      term: z.string().min(1).max(100),
      partOfSpeech: z.string().max(40).optional(),
      meaning: z.string().min(1).max(300),
      example: z.string().max(300).optional(),
    })
  )
  .max(30);


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


// Rewarded-ad claim. token/signature are optional so the mock/dev flow keeps
// working with an empty body; in production ad.service verifies them and the
// endpoint fails closed if they're missing/invalid.
export const adRewardSchema = {
  body: z.object({
    token: z.string().min(1).max(512).optional(),
    signature: z.string().min(1).max(256).optional(),
  }),
};

// Cursor pagination for /cards/saved (cursor = SavedCard row id, a uuid).
export const savedCardsQuerySchema = {
  query: z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
};

// Cursor pagination for /promos/mine (cursor = StartupPromo id, a cuid string).
export const promosMineQuerySchema = {
  query: z.object({
    cursor: z.string().min(8).max(64).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  }),
};