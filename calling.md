# Huevix Practice Calls — Setup Guide

This adds a **1:1 audio + video "Find People" calling** feature: open the app → **Talk** tab → **Find People** → you're matched with another available user → you talk live. Built in-house with **WebRTC + Socket.IO signaling + self-hosted TURN** (no paid per-minute SDK).

Pricing is **not** wired in yet (recharge/credit model comes later — see the last section for the hook point).

---

## What's in this package

```
backend/    → drop into your Huevix (Node/Express) repo
frontend/   → drop into your Huevix (Expo) repo
```

**Backend — NEW files** (drop in as-is):
`src/realtime/socket.js`, `presence.js`, `rooms.js`, `matchmaking.js`, `signaling.js`,
`src/controllers/calls.controller.js`, `src/routes/calls.routes.js`, `src/services/safety.service.js`

**Backend — MODIFIED files** (these are the full updated versions — replace yours if you haven't changed them since, otherwise merge):
`src/server.js`, `src/config/env.js`, `src/routes/index.js`, `prisma/schema.prisma`

**Frontend — NEW files**: `lib/socket.ts`, `lib/calls.ts`, `context/call.tsx`, `app/(tabs)/talk.tsx`
**Frontend — MODIFIED files**: `app/_layout.tsx`, `app/(tabs)/_layout.tsx`, `app.json`

---

## 1. Backend setup

```bash
cd <Huevix repo>

# 1. dependency
npm install socket.io

# 2. database — adds Call + Block + Report tables and their enums
npx prisma migrate dev --name add_calls_and_safety
npx prisma generate
```

**Env vars** (add to `.env`). STUN has a working default, so for a first LAN test you can skip TURN entirely:

```bash
# Optional — defaults to Google's public STUN if unset
STUN_URLS=stun:stun.l.google.com:19302

# TURN — required for reliable calls on cellular / strict NAT (see section 3)
TURN_URLS=turn:your.turn.host:3478
TURN_STATIC_SECRET=<a long random string — must match coturn>
TURN_CRED_TTL_SECONDS=86400
```

Run the server the way you normally do. Socket.IO now shares the same HTTP port as the REST API. You'll see `Socket.IO realtime ready (practice calling)` on boot.

**New surface area:**
- `GET /api/v1/calls/turn-credentials` — returns ICE servers (STUN + short-lived signed TURN creds)
- `GET /api/v1/calls/history` — the user's last 20 calls
- `POST /api/v1/calls/report` — report a user (`{ userId, callId?, reason?, note? }`); also blocks them
- `POST /api/v1/calls/block` · `DELETE /api/v1/calls/block/:userId` · `GET /api/v1/calls/blocks`
- Socket.IO at `/socket.io` (same JWT access token as REST, sent on the handshake)

---

## 2. Frontend setup

```bash
cd <huevix repo>

npx expo install react-native-webrtc
npm install socket.io-client

# IMPORTANT: @config-plugins/* are pinned to Expo SDK majors. You're on SDK 54,
# so use the 13.x line. The latest (15.x) targets SDK 56 and fails peer-dep
# resolution on 54. (Mapping: 13→SDK54, 14→SDK55, 15→SDK56.) If you bump Expo
# later, bump this to match.
npm install @config-plugins/react-native-webrtc@^13

# regenerate native projects (injects camera/mic perms + WebRTC native setup)
npx expo prebuild --clean

# run on a real device (dev client — NOT Expo Go)
npx expo run:android      # or: npx expo run:ios
```

> **react-native-webrtc has native code, so it cannot run in Expo Go.** You already build native dev clients, so this is the same flow — just rebuild after installing.

A new **Talk** tab appears between Learn and Saved. Tap **Find People** (video) or **Audio only**. The in-call screen floats over the whole app, so a call survives tab switches.

---

## 3. TURN server (coturn) — do this before testing on cellular

STUN alone connects most phones on the same Wi-Fi, but **on mobile data a large share of calls need a relay**. TURN is that relay. coturn is free; you just need a small VPS.

```bash
# Ubuntu VPS
sudo apt update && sudo apt install -y coturn
```

`/etc/turnserver.conf` (minimal):

```
use-auth-secret
static-auth-secret=<SAME value as TURN_STATIC_SECRET in the backend .env>
realm=your.turn.host
listening-port=3478
tls-listening-port=5349
min-port=49160
max-port=49200
# external-ip=<PUBLIC_IP>      # set if the box is behind NAT
fingerprint
no-cli
```

Open the firewall: **UDP+TCP 3478**, **5349** (TLS), and the **UDP relay range 49160–49200**. Start it: `sudo systemctl enable --now coturn`.

Then set `TURN_URLS=turn:your.turn.host:3478` and the matching `TURN_STATIC_SECRET` in the backend. The backend signs a short-lived username/credential per request — no static TURN password ships in the app.

---

## 4. Testing checklist

1. **Two physical devices**, two different accounts, both signed in.
2. Both open **Talk** → **Find People**. They should match within a second and connect.
3. Test **Wi-Fi first**, then put **one device on cellular** — this is the case that exercises TURN. If it connects on Wi-Fi but not on cellular, your TURN config is the thing to fix.
4. Through the **Cloudflare tunnel**: Socket.IO needs the WebSocket upgrade to pass through. Cloudflare forwards `Upgrade` headers by default, so it should "just work," but confirm the socket connects (not stuck reconnecting) when hitting the tunnel URL.
5. Try mic mute, camera off, flip camera, and hang up — and confirm the other side gets dropped cleanly when one person leaves or kills the app.

---

## 5. Safety — report & block (included)

Random-stranger video needs this, so it's wired in:

- A **flag button** on the call overlay opens a reason sheet (harassment, nudity/sexual content, user appears underage, hate, spam, other).
- Submitting a report **blocks that user and ends the call** in one tap.
- **Blocked pairs are never matched again** — the matchmaker checks blocks in *both* directions before pairing (verified in tests).
- Reports land in a `Report` table with a `status` (PENDING / REVIEWED / ACTIONED) for you to moderate. There's no admin UI yet — query the table, or build a simple review screen later.
- Endpoints also support explicit block / unblock / list-blocks if you want a "blocked users" settings screen.

## 6. What's intentionally NOT built yet

These were scoped out for this first cut — flagging so nothing's a surprise:

- **Recharge / credit metering.** The hook point: in `matchmaking.js` `find_partner`, before pairing, check the user's balance; and in `rooms.js` `endRoom`, deduct based on `durationSec`. Reuse `entitlement.service.js` and the daily-cap fields already on `User`.
- **Push-to-ring when the app is closed.** Current model is "both tap Find People." For true incoming calls, add `react-native-callkeep` + a push (FCM/APNs) wake.
- **Match filters** (by level / language) — extend the `find_partner` payload and the queue scan.
- **Scaling past one server** — the matchmaking queue + room map live in one process. For multiple API instances, move that routing to Redis pub/sub.
- **Moderation dashboard** — the `Report` table is populated; reviewing it is manual for now.

---

## Notes / gotchas

- The matchmaking queue and active-call rooms are **in-memory** (single process) — correct for launch, see scaling note above.
- The signaling server is a **dumb relay**: it never inspects or stores SDP/ICE; it only forwards between the two verified participants of a room.
- A call that's matched but never connects is recorded as `MISSED`; a normal call is `ENDED` with `durationSec` — handy later for billing and analytics.
