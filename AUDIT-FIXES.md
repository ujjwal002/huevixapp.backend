# Audit Fixes — 15 July 2026

This documents the changes applied in response to the engineering audit. Two
buckets: **substantive fixes** (behavior/security/CI) and **mechanical**
(formatting). Read the substantive list to know what actually changed.

---

## Substantive changes

### Security / hardening

1. **`nodemailer` 6.9 → ^9.0.3** (`package.json`, `package-lock.json`)
   Clears the one *reachable* production HIGH (SMTP command injection via CRLF,
   header injection, email-to-unintended-domain). The basic
   `createTransport({host,port,secure,auth})` + `sendMail({from,to,subject,text})`
   API you use is unchanged across the major bump.
   → **ACTION: test OTP email** (register / forgot-password) in both mock mode
   and with your real Resend/SMTP creds before deploying.

2. **CI audit gate** (`.github/workflows/ci.yml`)
   Build now **fails on any HIGH+ advisory in production deps**
   (`npm audit --omit=dev --audit-level=high`) so this can't silently drift
   again. A second, non-blocking `npm audit` step keeps dev-tooling advisories
   visible without breaking the build.

3. **TURN credential TTL 24h → 1h** (`src/config/env.js`)
   REST TURN creds are handed to the client; a leak is now good for ~1h of
   relay, not a day. Override with `TURN_CRED_TTL_SECONDS`.

4. **Production access logs no longer store raw client IPs** (`src/app.js`)
   New `anonymizeIp()` masks the last octet (IPv4 / IPv4-mapped IPv6) or keeps
   only the first three hextets (IPv6). Keeps "same network" correlation for
   debugging without retaining a raw personal identifier (DPDP). The RTDN-secret
   redaction you already had is unchanged.

5. **CSP on the two public HTML pages** (`src/app.js`)
   `/privacy` and `/delete-account` now send a strict `Content-Security-Policy`
   (blocks ALL script — they have none — allows their inline `<style>`, forbids
   framing/plugins). `helmet()` doesn't set a CSP by default; JSON responses are
   unaffected.

6. **Matchmaking credit gate now fails CLOSED** (`src/realtime/matchmaking.js`)
   Previously, if the balance check threw, the random-call path allowed the call
   (`allowed: true`). Since random VIDEO can spend coins, it now denies with a
   retry message on error — matching the tutor-call preflight.

### Correctness

7. **`socket.js` missing import — real runtime bug** (`src/realtime/socket.js`)
   `createAdapter(pub, sub)` was called but never imported. Setting `REDIS_URL`
   would crash the realtime layer on boot with `createAdapter is not defined` —
   i.e. the multi-instance path was broken. Added
   `import { createAdapter } from '@socket.io/redis-adapter'`.

8. **`deleteMe` session-invalidation made explicit** (`src/controllers/user.controller.js`)
   Behavior was already correct (user delete cascades to refresh tokens; the
   stateless access token is rejected on the next request because the user is
   gone). Added a comment so a future *soft*-delete refactor can't silently leave
   live sessions.

### CI hygiene (was already red before these changes)

9. **Lint is now clean** — fixed pre-existing `eslint` errors that were failing
   `npm run lint` (unused imports/vars in `dailyVocab.service.js`,
   `vocabTutor.service.js`, `summarize.js`, `speech.service.js`, `seed.js`;
   an empty catch in `news-fetch.js`; a stale eslint-disable in
   `errorHandler.js`). None were in the files changed for security reasons.

10. **SECURITY.md corrected** — added a dated banner; the "all green" table is
    now marked historical. Real dependency status is enforced in CI.

11. **setup.md / SECURITY.md recon trim** — replaced the real backup-bucket name
    and absolute server paths (`/home/ubuntu/huevixapp.backend`) with
    placeholders, since these ship in the repo.

---

## Mechanical change

- **Prettier normalized the whole codebase** (`npm run format`). Your
  `format:check` CI step was failing on ~80 files (the code had never been
  prettier-formatted — verified against your original zip). This is the bulk of
  the file diff and is **whitespace/quotes only, no behavior change**. Lint and
  the runnable test suite pass identically before and after.

---

## Verified in this pass

- `npx eslint .` → clean (exit 0)
- `npm run format:check` → clean
- `npx vitest run` → **40 tests pass, 8 suites pass.** Two suites
  (`quiz.test.js`, `routeMounting.test.js`) instantiate `PrismaClient` and
  couldn't run in the sandbox (Prisma's engine binary download was network-
  blocked). They will run in your environment/CI where `prisma generate`
  succeeds.

## Not changed (deliberately) — see audit for rationale

- **Redis migration for realtime state** (matchmaking queue / presence / rooms /
  invites / billing watchdog). This is a large, careful piece of work; rushing it
  risks breaking billing, which is worse than the current honest single-instance
  constraint. The `createAdapter` fix (#7) unblocks the *adapter*, but shared
  state is still in-process — **do not run more than one instance until the state
  migration is done.**
- **Structured logging (pino)**, **feed in-memory reordering**, **per-request
  auth caching**, **mixed uuid/cuid IDs**, **dead Razorpay code** — deferred;
  either premature at current scale or cosmetic. Fold the manual `test-*.js`
  race scripts into the automated suite once you have a test DB in CI (a real DB
  is required to meaningfully test the atomic credit reservation).
- **`uuid` moderate** (via optional Azure Speech SDK) — left in place; npm's fix
  downgrades the SDK. Low real risk (needs `buf` passed to uuid, which the SDK
  controls).
