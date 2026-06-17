import dotenv from 'dotenv';
dotenv.config();

const bool = (v, def = false) =>
  v === undefined ? def : ['true', '1', 'yes'].includes(String(v).toLowerCase());
const int = (v, def) => {
  if (v === undefined) return def;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? def : n; // ignore malformed numeric env vars
};

const NODE_ENV = process.env.NODE_ENV || 'development';
const isProd = NODE_ENV === 'production';

const DEV_ACCESS_SECRET = 'dev-access-secret';
const DEV_REFRESH_SECRET = 'dev-refresh-secret';

export const config = {
  env: NODE_ENV,
  port: int(process.env.PORT, 4000),
  apiPrefix: process.env.API_PREFIX || '/api/v1',

  databaseUrl: process.env.DATABASE_URL,

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || DEV_ACCESS_SECRET,
    refreshSecret: process.env.JWT_REFRESH_SECRET || DEV_REFRESH_SECRET,
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

  // Fix #2: mock external services only outside production by default. A
  // forgotten env var must never silently disable payment/signature checks in
  // prod — so the default here is false when NODE_ENV=production.
  mockExternal: bool(process.env.MOCK_EXTERNAL, !isProd),

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

  // Minor fix: default CORS origin now matches the Vite dev frontend (5173)
  // referenced elsewhere in the app, plus the old 3000 default.
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:5173,http://localhost:3000')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

// ---------------------------------------------------------------------------
// Fix #1: refuse to boot in production with insecure config. A default/blank
// JWT secret would let anyone forge tokens; mock mode would skip payment and
// signature verification. Fail fast and loudly instead.
// ---------------------------------------------------------------------------
if (isProd) {
  const problems = [];
  if (!process.env.JWT_ACCESS_SECRET || config.jwt.accessSecret === DEV_ACCESS_SECRET) {
    problems.push('JWT_ACCESS_SECRET is missing or using the insecure dev default');
  }
  if (!process.env.JWT_REFRESH_SECRET || config.jwt.refreshSecret === DEV_REFRESH_SECRET) {
    problems.push('JWT_REFRESH_SECRET is missing or using the insecure dev default');
  }
  if (config.mockExternal) {
    problems.push('MOCK_EXTERNAL must be false in production (mock skips payment/signature checks)');
  }
  if (!config.databaseUrl) {
    problems.push('DATABASE_URL is required');
  }
  if (problems.length) {
    throw new Error(
      `Refusing to start in production with insecure configuration:\n  - ${problems.join('\n  - ')}`
    );
  }
}

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