# LingoShorts — Backend (v1)

An Inshorts-style daily language-learning API. Each card is a short text the
learner can **read**, **listen** to, and **speak** — with vocab meanings in their
own language, daily streaks, a freemium model, and Razorpay subscriptions.

Built so adding a new language is a **config change, not a rewrite**.

---

## What's in v1

- **Auth** — email/password register & login, JWT access tokens, rotating refresh tokens.
- **Cards (read/listen)** — paginated feed filtered to the user's target language; full card with vocab in the user's native language; cached TTS audio.
- **Speaking (the paid feature)** — upload a recording, get pronunciation scores + per-word "what you did great / wrong" feedback (Azure Pronunciation Assessment).
- **Freemium entitlements** — free lifetime taste of speaking → paywall → ₹100/mo or ₹999/yr; daily cap for subscribers; rewarded-ad bonus credits.
- **Streaks** — increment once/day on any qualifying activity.
- **Subscriptions** — Razorpay order creation, signature verification, webhook.
- **Admin** — create cards manually or AI-generate them (text + vocab + audio).

Everything runs **out of the box in mock mode** (no external accounts needed).

---

## Tech stack

Node.js + Express · PostgreSQL via Prisma · JWT · multer (audio upload) · zod
(validation). External integrations: Anthropic (content), Azure Speech (TTS +
pronunciation assessment), Razorpay (payments) — all behind a `MOCK_EXTERNAL`
flag.

---

## Quick start

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env        # works as-is in mock mode; set DATABASE_URL

# 3. Database (needs a running PostgreSQL)
npm run prisma:generate
npm run prisma:migrate      # creates tables
npm run seed                # admin + learner + a sample English card

# 4. Run
npm run dev                 # http://localhost:4000/api/v1
```

Seeded logins (password `Password123`): `admin@lingoshorts.app`,
`learner@lingoshorts.app`.

> No PostgreSQL handy? The fastest path is a free hosted Postgres (Neon/Supabase/
> Railway) — paste its connection string into `DATABASE_URL`.

---

## Going live (flip off mock mode)

Set `MOCK_EXTERNAL=false` and provide:

| Feature | Provider | Keys |
| --- | --- | --- |
| Card + vocab generation | Anthropic | `ANTHROPIC_API_KEY` |
| Listening audio (TTS) | Azure Speech | `AZURE_SPEECH_KEY`, `AZURE_SPEECH_REGION` |
| Speaking assessment | Azure Speech | (same keys) |
| Payments | Razorpay | `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` |

Install the optional SDKs when you switch a feature on:
`npm install microsoft-cognitiveservices-speech-sdk razorpay @anthropic-ai/sdk`

### Storage: local ↔ S3 (one switch)

Storage is selected by a single env var, `STORAGE_DRIVER`:

```bash
STORAGE_DRIVER=local   # default — writes ./storage, served at /static
STORAGE_DRIVER=s3      # uploads to S3 instead; nothing else in the code changes
```

When `STORAGE_DRIVER=s3`, also set:

```bash
S3_BUCKET=your-bucket
S3_REGION=ap-south-1                       # or AWS_REGION
AWS_ACCESS_KEY_ID=...                      # standard AWS creds (or an IAM role)
AWS_SECRET_ACCESS_KEY=...
# optional:
STORAGE_PUBLIC_BASE_URL=https://cdn.example.com   # CloudFront/CDN for public assets
S3_ENDPOINT=https://...                    # for S3-compatible stores (R2/MinIO)
S3_FORCE_PATH_STYLE=true                   # usually needed with S3_ENDPOINT
```

Install the SDKs when you flip it on:
`npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`

**Bucket setup (important):** keep the bucket **private**. Public-read access is
only needed for the `tts/` and `images/` prefixes (TTS audio and article
images) — grant those via a bucket policy or, preferably, put CloudFront in
front and point `STORAGE_PUBLIC_BASE_URL` at it. The `recordings/` prefix must
stay private: the app never exposes it, and serves each recording to its owner
through a short-lived presigned URL.

---

## Adding a new language (the whole job)

1. Add a row to `SUPPORTED_LANGUAGES` in `src/config/env.js` (name, Azure locale, TTS voice).
2. (Optional) add a native language to `SUPPORTED_NATIVE_LANGUAGES`.
3. Generate cards for it via `POST /cards/generate`.

No schema changes, no controller changes. That's the design paying off.

---

## API reference (prefix `/api/v1`)

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | — | Liveness + mock flag |
| GET | `/meta` | — | Supported languages, pricing, entitlement rules |
| POST | `/auth/register` | — | Create account |
| POST | `/auth/login` | — | Log in |
| POST | `/auth/refresh` | — | Rotate tokens |
| POST | `/auth/logout` | — | Revoke a refresh token |
| GET | `/users/me` | ✓ | Profile |
| PATCH | `/users/me` | ✓ | Update name / languages |
| GET | `/users/me/stats` | ✓ | Streak, counts, entitlement summary |
| GET | `/cards/feed` | ✓ | Daily feed (target-language filtered, paginated) |
| GET | `/cards/:id` | ✓ | Card + vocab in native language |
| POST | `/cards/:id/complete` | ✓ | Mark read/listen done → streak |
| POST | `/cards/:id/speak` | ✓ | **Speaking assessment (gated)** — multipart `audio` |
| GET | `/speaking/history` | ✓ | Past attempts |
| POST | `/ads/reward` | ✓ | Claim a rewarded-ad speaking credit |
| GET | `/subscription` | ✓ | Current subscription |
| POST | `/subscription/checkout` | ✓ | Create Razorpay order |
| POST | `/subscription/verify` | ✓ | Activate after payment |
| POST | `/subscription/webhook` | — | Razorpay events (raw body) |
| POST | `/cards` | admin | Create a card manually |
| POST | `/cards/generate` | admin | AI-generate a card + vocab + audio |

### The speaking flow

```
client records audio of the user reading the card
   → POST /cards/:id/speak  (multipart: audio)
       → entitlement gate (trial → ad credit → subscription → 402 paywall)
       → assessPronunciation(audio, card.body, targetLanguage)
       → store attempt + consume credit + update streak
   ← scores + per-word breakdown + friendly feedback
```

A `402 PAYMENT_REQUIRED` with code `PAYWALL` is your cue to show the subscribe
screen. Code `DAILY_LIMIT_REACHED` means a subscriber hit the daily cap.

---

## Project structure

```
src/
  config/env.js            # config + LANGUAGE REGISTRY (scalability hinge)
  db/prisma.js             # Prisma client
  middleware/              # auth, validation, rate limits, errors
  services/                # ai, tts, speech (assessment), entitlement, streak, payment, storage
  controllers/             # auth, user, card, speaking, ads, subscription
  routes/                  # wiring
  app.js / server.js       # bootstrap
prisma/schema.prisma       # data model
prisma/seed.js             # demo data
```

---

## Notes & next steps

- **Audio format:** Azure pronunciation assessment expects 16 kHz mono PCM WAV.
  Have the client record in that format, or transcode (ffmpeg) in
  `speech.service.js` before assessment.
- **Ad reward security:** verify rewarded ads via your ad network's server-side
  callback (e.g. AdMob SSV) before granting credits in production.
- **Timezone:** streak/day logic is UTC-based; switch to IST in `utils/dates.js`
  if you want day boundaries at local midnight.
- **Background jobs:** TTS generation runs inline on card creation for v1; move
  it to a queue (BullMQ) when content volume grows.
```