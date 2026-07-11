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
    // Rewarded ad -> free NORMAL-call time (audio-only, expires at UTC
    // midnight, can never fund tutor calls). 2 min per ad, 5 ads/day.
    adRewardCallSeconds: int(process.env.AD_REWARD_CALL_SECONDS, 120),
    maxAdCallGrantsPerDay: int(process.env.MAX_AD_CALL_GRANTS_PER_DAY, 5),
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

  // Hard deadline (ms) for any single outbound call to a paid/3rd-party API
  // (OpenAI, Azure TTS, Azure pronunciation assessment, Razorpay). These run
  // inline on request handlers, so without a deadline a hung upstream would pin
  // a worker indefinitely. On timeout the caller gets a clean 503.
  externalTimeoutMs: int(process.env.EXTERNAL_TIMEOUT_MS, 25_000),

  // Rewarded-ad verification. The client forwards a signed reward token; we
  // verify it before granting a credit so the endpoint can't be spoofed with an
  // empty request. Mock mode skips it; production with no secret FAILS CLOSED.
  ads: {
    rewardSecret: process.env.AD_REWARD_SECRET || process.env.ADMOB_SSV_SECRET || null,
  },

  // Conversational vocab tutor (the strict Hindi roaster). Voice + lesson sizing
  // and a hard per-session turn cap so one session can't run up unbounded cost.
  tutor: {
    hindiVoice: process.env.TUTOR_HINDI_VOICE || 'hi-IN-MadhurNeural',
    hindiPitch: process.env.TUTOR_HINDI_PITCH || '+22%', // raise for a younger / boyish voice
    hindiRate: process.env.TUTOR_HINDI_RATE || '+3%',
    newWordsPerDay: int(process.env.TUTOR_NEW_WORDS_PER_DAY, 20),
    quizCount: int(process.env.TUTOR_QUIZ_COUNT, 6),
    maxTurnsPerSession: int(process.env.TUTOR_MAX_TURNS, 80),
  },


    elevenLabs: {
    apiKey: process.env.ELEVENLABS_API_KEY || null,
    voiceId: process.env.ELEVENLABS_VOICE_ID || null,
    modelId: process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2',
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

  // Google Sign-In (the LOGIN feature; separate from Google Play billing).
  // Comma-separated OAuth client IDs the app's ID tokens may be issued for —
  // typically the Web client ID (Expo/React Native uses it for the idToken
  // audience) plus the Android client ID.
  googleOAuth: {
    clientIds: (process.env.GOOGLE_OAUTH_CLIENT_IDS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },

  // Outbound email (verification + password-reset OTPs) over plain SMTP, so any
  // provider works: Gmail app password, AWS SES, Resend, Brevo, ... In mock
  // mode (or with no SMTP_HOST) codes are logged to the console instead.
  email: {
    // Preferred: Resend's HTTP API — set just RESEND_API_KEY (+ EMAIL_FROM).
    resendApiKey: process.env.RESEND_API_KEY || '',
    host: process.env.SMTP_HOST || '',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false), // true for port 465
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.EMAIL_FROM || 'Huevix <no-reply@huevix.com>',
    otpTtlMinutes: int(process.env.EMAIL_OTP_TTL_MINUTES, 15),
    otpMaxAttempts: int(process.env.EMAIL_OTP_MAX_ATTEMPTS, 5),
  },

  // Tutor marketplace economics. Tutors EARN ratePaisePerHour per hour of
  // ACTIVE talk time (₹150/hr default). Learners PAY for tutor calls from
  // their prepaid callSecondsBalance ONLY (no free daily minutes) — so keep
  // Play credit-pack pricing above ₹2.50/min or tutor calls lose money.
  // Coin economy. Purchased coins are the only paid currency; the free daily
  // allowance stays denominated in seconds (audio, normal calls only).
  //   normal call: 4 coins/sec (240/min)  -> ₹99 pack ≈ 50 normal minutes
  //   tutor call: 12 coins/sec (720/min)  -> ₹99 pack ≈ 16.6 tutor minutes
  coins: {
    normalPerSec: int(process.env.COINS_NORMAL_PER_SEC, 4),
    tutorPerSec: int(process.env.COINS_TUTOR_PER_SEC, 12),
  },

  tutorMarket: {
    ratePaisePerHour: int(process.env.TUTOR_RATE_INR_PER_HOUR, 150) * 100,
    inviteTimeoutMs: int(process.env.TUTOR_INVITE_TIMEOUT_MS, 30_000),
  },

  googlePlay: {
    packageName: process.env.GOOGLE_PLAY_PACKAGE_NAME || '',
    // Full service-account JSON string OR a path to the key file — filled in later.
    serviceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON || '',
    subMonthlyId: process.env.GOOGLE_SUB_MONTHLY_ID || 'premium_monthly',
    subYearlyId: process.env.GOOGLE_SUB_YEARLY_ID || 'premium_yearly',
    rtdnSecret: process.env.GOOGLE_RTDN_SECRET || '',
    // One-time consumable packs: productId -> SECONDS of call credit granted.
    // Play product id -> COINS granted. Legacy minute packs keep working and
    // grant their old value in coins (1 old second = 4 coins).

    rtdnAudience: process.env.GOOGLE_RTDN_AUDIENCE || '',
    rtdnServiceAccountEmail: process.env.GOOGLE_RTDN_SA_EMAIL || '',
    creditPacks: {
      [process.env.GOOGLE_PACK_30MIN_ID || 'call_credits_30min']: 30 * 60 * 4,
      [process.env.GOOGLE_PACK_60MIN_ID || 'call_credits_60min']: 60 * 60 * 4,
      [process.env.GOOGLE_PACK_120MIN_ID || 'call_credits_120min']: 120 * 60 * 4,
      coins_5500: 5500, // ₹49
      coins_12000: 12000, // ₹99
      coins_26000: 26000, // ₹199
      coins_56000: 56000, // ₹399
    },
  },

  // Realtime practice calling: WebRTC ICE servers + signaling.
  // STUN is free and discovers public addresses; TURN relays media when a
  // direct peer-to-peer path fails (essential on mobile/cellular). coturn runs
  // in `use-auth-secret` mode and accepts the short-lived HMAC credentials we
  // sign per-request (see calls.controller.js), so no static TURN password is
  // ever shipped in the app. Leave TURN_* unset in dev to run STUN-only on LAN.
  realtime: {
    stunUrls: (process.env.STUN_URLS || 'stun:stun.l.google.com:19302')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    turnUrls: (process.env.TURN_URLS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
    turnStaticSecret: process.env.TURN_STATIC_SECRET || null,
    turnCredentialTtlSec: int(process.env.TURN_CRED_TTL_SECONDS, 86_400),
  },

  calls: {
    // Free daily allowance is AUDIO-ONLY (see entitlement.service.js). 2 minutes.
    freeDailySeconds: int(process.env.FREE_DAILY_CALL_SECONDS, 1800),
    minStartSeconds: int(process.env.MIN_CALL_START_SECONDS, 20),
    rechargePacks: { mins_30: 1800, mins_60: 3600, mins_120: 7200 },
  },

  redis: {
    url: process.env.REDIS_URL || null,
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

// One-line boot signal so it's obvious which TTS provider the tutor will use.
if (!config.mockExternal) {
  const ttsProvider =
    config.elevenLabs.apiKey && config.elevenLabs.voiceId
      ? 'ElevenLabs'
      : config.azureSpeech.key
        ? 'Azure'
        : 'mock';
  console.log(`[tts] tutor voice provider: ${ttsProvider}`);
}