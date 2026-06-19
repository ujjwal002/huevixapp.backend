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

// --- Storage (single switch: STORAGE_DRIVER = local | s3) -------------------
const STORAGE_DRIVER = process.env.STORAGE_DRIVER || 'local';
const S3_BUCKET = process.env.S3_BUCKET;
const S3_REGION = process.env.S3_REGION || process.env.AWS_REGION || 'ap-south-1';
const S3_ENDPOINT = process.env.S3_ENDPOINT || undefined; // for S3-compatible (R2/MinIO)
const S3_FORCE_PATH_STYLE = bool(process.env.S3_FORCE_PATH_STYLE, false);

// Where PUBLIC assets (TTS audio, article images) are served from. For s3 we
// derive a sensible default from the bucket so it works before a CDN is set up;
// override with STORAGE_PUBLIC_BASE_URL (e.g. a CloudFront domain).
function defaultPublicBase() {
  if (STORAGE_DRIVER !== 's3') return 'http://localhost:4000/static';
  if (S3_ENDPOINT) {
    const base = S3_ENDPOINT.replace(/\/$/, '');
    return S3_FORCE_PATH_STYLE && S3_BUCKET ? `${base}/${S3_BUCKET}` : base;
  }
  if (S3_BUCKET) return `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com`;
  return 'http://localhost:4000/static'; // s3 selected but unconfigured; validated below
}

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
  bcryptRounds: int(process.env.BCRYPT_ROUNDS, 12),

  // Number of reverse-proxy hops to trust for client IP resolution. The app is
  // deployed behind cloudflared/ngrok (see setup.md), so without this every
  // request looks like it comes from 127.0.0.1 and the per-IP rate limiters
  // collapse into a single global bucket. Set to the real hop count (1 for a
  // single tunnel/CDN in front). A numeric value keeps express-rate-limit happy
  // (it rejects the permissive `true`, which would let clients spoof IPs).
  trustProxy: int(process.env.TRUST_PROXY, 1),

  entitlement: {
    freeSpeakingTrial: int(process.env.FREE_SPEAKING_TRIAL, 3),
    paidDailySpeakingLimit: int(process.env.PAID_DAILY_SPEAKING_LIMIT, 30),
    maxAdCreditsPerDay: int(process.env.MAX_AD_CREDITS_PER_DAY, 3),
  },

  pricing: {
    monthlyInr: int(process.env.PRICE_MONTHLY_INR, 100),
    yearlyInr: int(process.env.PRICE_YEARLY_INR, 999),
    promoPerDayInr: int(process.env.PROMO_PER_DAY_INR, 299),
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
    driver: STORAGE_DRIVER, // 'local' | 's3'  — the one switch
    publicBaseUrl: (process.env.STORAGE_PUBLIC_BASE_URL || defaultPublicBase()).replace(/\/$/, ''),
    s3: {
      bucket: S3_BUCKET,
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: S3_FORCE_PATH_STYLE,
    },
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
// Storage config validation. Fail fast on an unknown driver, or on s3 selected
// without a bucket — so a half-configured switch can't silently misbehave.
// (AWS credentials come from the standard AWS env vars / IAM role.)
// ---------------------------------------------------------------------------
if (!['local', 's3'].includes(config.storage.driver)) {
  throw new Error(`Unknown STORAGE_DRIVER "${config.storage.driver}" (expected "local" or "s3")`);
}
if (config.storage.driver === 's3' && !config.storage.s3.bucket) {
  throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET (set it plus AWS credentials before switching)');
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