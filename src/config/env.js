import dotenv from 'dotenv';
dotenv.config();

const bool = (v, def = false) =>
  v === undefined ? def : ['true', '1', 'yes'].includes(String(v).toLowerCase());
const int = (v, def) => (v === undefined ? def : parseInt(v, 10));

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: int(process.env.PORT, 4000),
  apiPrefix: process.env.API_PREFIX || '/api/v1',

  databaseUrl: process.env.DATABASE_URL,

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret',
    accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTtlDays: int(process.env.REFRESH_TOKEN_TTL_DAYS, 30),
  },
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 10),

  entitlement: {
    freeSpeakingTrial: int(process.env.FREE_SPEAKING_TRIAL, 3),
    paidDailySpeakingLimit: int(process.env.PAID_DAILY_SPEAKING_LIMIT, 30),
    maxAdCreditsPerDay: int(process.env.MAX_AD_CREDITS_PER_DAY, 3),
  },

  pricing: {
    monthlyInr: int(process.env.PRICE_MONTHLY_INR, 100),
    yearlyInr: int(process.env.PRICE_YEARLY_INR, 999),
  },

  mockExternal: bool(process.env.MOCK_EXTERNAL, true),

  ai: {
    apiKey: process.env.OPENAI_API_KEY,
    model: process.env.AI_MODEL || 'gpt-4o-mini',
  },
  azureSpeech: {
    key: process.env.AZURE_SPEECH_KEY,
    region: process.env.AZURE_SPEECH_REGION || 'centralindia',
  },
  storage: {
    driver: process.env.STORAGE_DRIVER || 'local',
    publicBaseUrl: process.env.STORAGE_PUBLIC_BASE_URL || 'http://localhost:4000/static',
  },
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID,
    keySecret: process.env.RAZORPAY_KEY_SECRET,
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET,
    planMonthly: process.env.RAZORPAY_PLAN_MONTHLY,
  },

  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

// ---------------------------------------------------------------------------
// Language registry — the ONLY place you touch to launch a new language.
// Maps an ISO code to its TTS voice + the locale used by Azure pronunciation
// assessment. Launch is English-only; uncomment others when content is ready.
// ---------------------------------------------------------------------------
export const SUPPORTED_LANGUAGES = {
  en: { name: 'English', locale: 'en-US', ttsVoice: 'en-US-JennyNeural' },
  // hi: { name: 'Hindi',   locale: 'hi-IN', ttsVoice: 'hi-IN-SwaraNeural' },
  // es: { name: 'Spanish', locale: 'es-ES', ttsVoice: 'es-ES-ElviraNeural' },
  // To launch a language: add a row here, generate content for it, done.
};

// Native languages we can render vocab meanings in (translation targets).
export const SUPPORTED_NATIVE_LANGUAGES = {
  hi: 'Hindi',
  en: 'English',
  // es: 'Spanish',
};

export function isSupportedTarget(code) {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, code);
}
export function isSupportedNative(code) {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_NATIVE_LANGUAGES, code);
}
export function languageMeta(code) {
  return SUPPORTED_LANGUAGES[code] || null;
}
