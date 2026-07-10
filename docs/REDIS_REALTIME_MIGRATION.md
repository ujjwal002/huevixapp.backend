# Redis Realtime Migration — Stages 2–6 (deferred)

**Status:** Stage 1 is DONE and shipped (inert). Stages 2–6 are NOT built yet.
Build them only when you actually need to run more than one API instance.
Until then, the single instance keeps working exactly as-is.

This document is the map for finishing the job later, so it can be picked up
cold without re-deriving the design.

---

## 0. Why this exists / the one-paragraph refresher

The realtime calling layer (matchmaking, presence, live call "rooms", tutor
call invites, and the billing watchdog) keeps its state in **plain in-process
JavaScript `Map`/array objects**. That is correct and simplest for ONE server.
The moment a second API instance runs behind a load balancer, those Maps are no
longer shared, and the feature breaks in specific ways (see §2). Fixing it means
moving that shared state into **Redis**, plus using the **Socket.IO Redis
adapter** so a message for a socket on instance B can be sent from instance A.

**Stage 1 (already done):** added the shared Redis client (`src/db/redis.js`)
and wired the Socket.IO Redis adapter in `src/realtime/socket.js`, both behind
the `REDIS_URL` env var. With `REDIS_URL` unset, everything is byte-for-byte the
current single-instance behavior. Stage 1 alone does NOT make you
multi-instance-safe — it only fixes cross-instance message delivery, not the
shared STATE. Do not run 2+ instances until Stages 2–5 (and the watchdog in 6)
are done.

---

## 1. WHEN to actually do this (the trigger)

Do NOT do this on a schedule or "to be safe". Do it when you hit a real signal:

- **A single instance is genuinely resource-constrained under real load.**
  Watch CPU / memory / event-loop lag metrics on the box. Note: the calling
  server does very little per call — WebRTC media flows peer-to-peer or through
  coturn (TURN), NOT through Node. The Node server only relays a handful of
  small SDP/ICE messages at call setup and ticks a 10s watchdog. One modest
  instance can hold tens of thousands of idle sockets and thousands of
  concurrent calls. So raw call capacity is usually NOT the reason you'll need
  this.
- **You need redundancy / high availability** — a single-box outage taking down
  all calling is now a business problem, not a minor blip.
- **You need truly zero-downtime deploys** and connection draining (already
  shipped) is no longer enough. Reminder: on a single instance, draining makes
  restarts graceful and correctly billed, but a long call still can't survive a
  deploy. Only multiple instances give fully transparent deploys.

If the only pain is "restarts drop calls", you already have connection draining
(see `src/server.js` shutdown). That is the cheap answer. Multi-instance is the
expensive answer — only pay for it when one of the above isactually true.

---

## 2. What breaks with 2+ instances if you DON'T do this

Concrete failure modes, so you can recognize them:

- **Matchmaking splits.** `waiting` (the FIFO queue in `matchmaking.js`) is
  per-process. User A on instance 1 and user B on instance 2 both wait forever
  and never match, even though each is looking for a partner.
- **Presence undercounts.** `userSockets` (`presence.js`) only sees the instance
  you ask. "Online count" is wrong; "is this tutor online" can be wrong.
- **Rooms not found cross-instance.** `rooms` / `socketRoom` (`rooms.js`) are
  per-process. If a call's two participants land on different instances,
  signaling relay and hangup can't find the room.
- **Tutor invites don't cross instances.** `invites` (`tutorCalls.js`) plus its
  `setTimeout` timers live in one process; a ring on instance 1 can't be
  accepted on instance 2.
- **DOUBLE BILLING (the dangerous one).** The billing watchdog runs
  `setInterval` in EVERY process. With N instances, N watchdogs each try to bill
  every call → users charged N times. `consumeCallSeconds` /
  `consumeBalanceSeconds` are NOT idempotent. This is the #1 thing the migration
  must get right (see §Stage 3 and §Stage 6).

---

## 3. Architecture decisions (settle these first)

1. **Load balancer + WebSocket support.** You need something that can proxy
   WebSocket upgrades to multiple Node instances (nginx `upstream` with
   `proxy_set_header Upgrade/Connection`, or an AWS ALB with stickiness). Decide
   which. Note: cloudflared tunnel to a single origin does NOT load-balance
   across instances by itself — going multi-instance means adding a real LB in
   front of the instances.
2. **Sticky sessions: helpful but NOT sufficient.** Session affinity keeps a
   given client on one instance, which simplifies per-client state. But a CALL
   has TWO clients who can still be on two different instances, so rooms +
   cross-instance emits are still required. Recommendation: enable stickiness
   (it reduces adapter chatter and makes Socket.IO's HTTP long-poll fallback
   reliable), but design as if any two participants may be on different
   instances.
3. **Redis deployment.** Managed Redis (e.g. AWS ElastiCache) or a self-run
   instance. One Redis is fine to start. Everything below assumes a single
   logical Redis reachable by all instances via `REDIS_URL`.
4. **Key namespace + TTLs.** Prefix all keys (e.g. `rt:`) and put TTLs on
   ephemeral state so a crashed instance can't leak stale entries forever
   (dead presence, orphan rooms). Pick a sweep/expiry strategy per stage.

---

## 4. Core safety principle (applies to every stage that touches money)

**Bill a call exactly once by making the room-removal the atomic "claim".**
In the current single-process code, `endRoom()` does `rooms.get(id)` then
`rooms.delete(id)` with NO `await` between them, so whichever caller runs first
claims the room and bills; a second concurrent call finds it gone and does
nothing. In Redis, replicate this with an **atomic delete that returns whether
this caller removed it**:

```
// pseudo: only the caller who actually removed the room key may bill
const removed = await redis.del(`rt:room:${roomId}`); // returns 1 or 0
if (removed === 1) {
  // ...compute duration, run billing (consumeCallSeconds / accrueEarning)...
}
```

`accrueEarning` is already idempotent via `unique(callId)` in Postgres, but the
coin/second spends are NOT — so the atomic-claim gate above is what prevents
double charges when a disconnect on one instance races the watchdog on another.
Every stage that ends/bills a call MUST go through this single claim.

---

## STAGE 2 — Presence → Redis

**Goal:** "who is online" and "which sockets does user X have" become shared
across instances. Lowest risk (no money involved); do it first.

**Files:** `src/realtime/presence.js` (rewrite internals), callers unchanged if
you keep the same exported function names.

**Current API to preserve:** `addPresence(userId, socketId)`,
`removePresence(userId, socketId)`, `isOnline(userId)`, `onlineCount()`,
`socketsForUser(userId)`.

**Redis design:**
- `rt:presence:user:<userId>` → a SET of that user's socketIds.
  `SADD` on connect, `SREM` on disconnect.
- `rt:presence:online` → a SET of userIds who have ≥1 socket. Add userId on
  first socket; remove when their socket set becomes empty.
- `onlineCount()` → `SCARD rt:presence:online`.
- `socketsForUser(userId)` → `SMEMBERS rt:presence:user:<userId>`.
- `isOnline(userId)` → `SISMEMBER rt:presence:online <userId>` (or EXISTS on the
  user set).

**Gotchas:**
- These become async (Redis calls). Callers that used them synchronously must be
  updated to `await`. Audit `presence.js` consumers: `socket.js`
  (connect/disconnect), `tutorCalls.js` (`socketsForUser`, `hasPushDevice` flow),
  and the online_count handler.
- **Stale presence on crash.** If an instance dies, its sockets never fire
  `disconnect`, leaving ghost entries. Mitigations: (a) put a TTL on the user
  set and refresh on activity, or (b) on startup an instance clears its own
  previously-owned socketIds, or (c) periodically reconcile against the adapter's
  known sockets. Simplest acceptable start: TTL + refresh.
- Keep a local fallback: if `redisEnabled()` is false, use the current in-process
  Maps (so single-instance dev still works with zero Redis).

**Test:** two instances, connect users to each, assert `onlineCount()` and
`socketsForUser` agree from both instances; kill one instance and confirm ghost
entries expire.

---

## STAGE 3 — Rooms → Redis (with atomic billing claim) — MONEY-CRITICAL

**Goal:** live call rooms are shared, and billing happens exactly once no matter
which instance ends the call. This is the careful one.

**Files:** `src/realtime/rooms.js` (rewrite storage + endRoom + drainAllRooms),
`src/realtime/signaling.js` (uses `getRoom`/`peerSocketId`), `socket.js`
(disconnect → `handleDisconnect`).

**Current API to preserve:** `createRoom`, `getRoom`, `roomIdForSocket`,
`peerSocketId`, `markActive`, `endRoom`, `handleDisconnect`, `activeCallCount`,
`drainAllRooms`, plus the watchdog (moved to Stage 6).

**Redis design:**
- `rt:room:<roomId>` → HASH of the room fields (callId, callerId, calleeId,
  callerSocketId, calleeSocketId, type, kind, startedAt, activeAt, markedActive).
  All scalars — serializes cleanly (unlike sockets, which is why this works).
- `rt:socketroom:<socketId>` → roomId (string), for reverse lookup. Set on
  create, deleted on end.
- `activeCallCount()` → maintain a SET `rt:rooms:active` of roomIds (or a
  counter), since you can't cheaply COUNT hashes. `SADD` on create, `SREM` on end.
- **Cross-instance emits:** `getRoom` + `peerSocketId` give you a socketId; then
  `io.to(socketId).emit(...)` works across instances **because the Stage-1 Redis
  adapter is attached.** This is the payoff of Stage 1.

**The billing claim (see §4):** `endRoom` becomes:
1. Read the room hash (for duration + participants).
2. `DEL rt:room:<roomId>` — if it returns 0, someone already ended it → STOP
   (no billing, no double charge).
3. If it returned 1: `SREM rt:rooms:active`, delete both `rt:socketroom:*`
   entries, then run the exact billing that exists today (RANDOM:
   `consumeCallSeconds` both sides; TUTOR: `consumeBalanceSeconds` learner +
   idempotent `accrueEarning` tutor), and update the `Call` row.

**Gotchas:**
- `markActive` must also update the hash (`markedActive`, `activeAt`) atomically;
  a `HSETNX`-style guard prevents two instances both flipping it.
- `handleDisconnect` on instance A must find the room (now in Redis) and end it,
  notifying the peer on instance B via the adapter. The billing claim guarantees
  only one of {disconnect, hangup, watchdog} bills.
- Orphan rooms if an instance crashes mid-call: add a TTL/heartbeat on the room
  hash and a sweeper that ends rooms whose owner instance vanished (Stage 6
  watchdog can double as the sweeper).

**Test (do this thoroughly — it's money):** two instances; place calls with
participants split across instances; end calls via (a) hangup, (b) disconnect,
(c) watchdog timeout — each MUST bill exactly once. Force a disconnect+hangup
race and assert a single charge and a single `Call` finalization.

---

## STAGE 4 — Matchmaking queue → Redis

**Goal:** one shared waiting queue so users on different instances get matched,
without two instances grabbing the same partner.

**Files:** `src/realtime/matchmaking.js` (rewrite the queue + matching),
`socket.js` (disconnect → `leaveQueue`).

**Current behavior to preserve:** FIFO-ish pairing; only pair same call type
(AUDIO↔AUDIO, VIDEO↔VIDEO); never pair blocked users (either direction); skip
disconnected sockets; a user can't match themselves.

**Redis design:**
- Separate queues per call type so "match same type" is a plain pop:
  `rt:mm:waiting:AUDIO`, `rt:mm:waiting:VIDEO` (Redis LISTs). Store
  `{userId, socketId, instanceId}` per entry (NOT the socket object — it can't be
  serialized; this is the core reason matchmaking must be redesigned).
- **Atomic match:** the hard part is "pop the first partner who is NOT blocked and
  NOT me". A plain `LPOP` can return a blocked user. Options:
  - **Simple/robust:** `LPOP` a candidate; check blocks (Postgres) + self + still
    connected; if unusable, hold it aside and `LPOP` the next; requeue the good
    ones you skipped. Works, slightly more round-trips.
  - **Advanced:** a Lua script for atomic "pop first eligible" — but blocks live
    in Postgres, not Redis, so Lua can't see them. You'd need block sets mirrored
    into Redis (`rt:blocks:<userId>`) for Lua to filter. Only do this if the
    simple approach shows contention.
- Use a short **lock** (`SET rt:mm:lock NX PX 2000`) around the pop-and-pair step
  so two instances don't both pair the same waiting user. Keep the critical
  section tiny.

**Gotchas:**
- **Cross-instance "matched" emit.** When instance A pairs A-user (on A) with
  B-user (on B), A creates the room (Stage 3) and emits `matched` to BOTH
  socketIds — the one on B is delivered via the Stage-1 adapter. Verify both
  sides receive it.
- **Stale entries.** A socket that disconnected while queued must be removed;
  `leaveQueue` deletes its entry, but also defend by validating "still connected"
  after popping (presence from Stage 2) and discarding dead entries.
- Duplicate-tap guard (already in code) must now check the shared queue.

**Test:** users queue on different instances and get matched; blocked pairs never
match; two instances hammering the queue never double-pair one user; disconnected
queuers are skipped.

---

## STAGE 5 — Tutor invites → Redis

**Goal:** a tutor-call ring started on one instance can be delivered/accepted on
another, including the timeout and the "ring all the tutor's devices" behavior.

**Files:** `src/realtime/tutorCalls.js` (rewrite `invites` map + timers +
accept/decline/cancel + `deliverPendingInvites` + `cleanupTutorInvites`).

**Current behavior to preserve:** learner rings a tutor (specific or auto-match);
tutor has an invite window (longer if only reachable via push); only the invited
tutor may accept; on accept, create a TUTOR room (Stage 3) with learner as
caller; re-check learner balance at accept; decline/cancel/timeout paths;
re-deliver a pending invite when the tutor's app connects.

**Redis design:**
- `rt:invite:<inviteId>` → HASH {learnerUserId, learnerSocketId, learnerInstance,
  tutorUserId, type, expiresAt}. Store IDs, not socket objects.
- Index by tutor so `deliverPendingInvites`/`cleanupTutorInvites` can find them:
  `rt:invites:tutor:<tutorUserId>` → SET of inviteIds.
- **Timeouts without in-process `setTimeout`:** the current code holds a JS timer
  per invite; that doesn't survive across instances. Replace with an expiry-driven
  approach: set `expiresAt` on the hash + a short TTL, and have a lightweight
  sweeper (piggyback on the Stage-6 watchdog tick) fire "invite expired →
  tell learner `tutor_unavailable`" for any invite past its deadline. Or use Redis
  keyspace notifications on expiry (more setup; the sweeper is simpler).
- **Emits across instances:** ring the tutor by emitting `tutor_incoming` to each
  of the tutor's socketIds (from Stage-2 presence) via the adapter; notify the
  learner on their socket similarly.

**Gotchas:**
- **Accept is a claim too:** `DEL rt:invite:<inviteId>` must return 1 for the
  accept to proceed, so two devices/instances can't both accept the same ring.
- Balance re-check at accept still applies (learner may have drained in a parallel
  call).
- Push-ring path (`pushToUser`) is unchanged, but "tutor has a live socket vs only
  push" now consults Redis presence (Stage 2).

**Test:** learner on instance A rings tutor whose devices are on instance B;
tutor accepts on B; room is created and both get `matched`; invite expiry fires
once; a second accept attempt is rejected.

---

## STAGE 6 — Billing watchdog leader-lock + full staging test

**Goal:** exactly ONE instance runs the live-billing watchdog (and the orphan
sweepers), so calls aren't billed N times. Then a real multi-instance test pass.

**Files:** `src/realtime/rooms.js` (the `startBillingWatchdog` / `watchdogTick`),
plus wherever sweepers for Stages 2/3/5 live.

**The problem:** today `startBillingWatchdog` runs `setInterval` in every process.
With N instances that's N watchdogs → N× billing. Must become a single active
watchdog.

**Redis design — leader election via lock:**
- Each instance tries `SET rt:watchdog:leader <instanceId> NX PX 15000` every,
  say, 10s. Whoever holds the key is the leader and runs the tick; others skip.
- The leader **renews** the lock each tick (`PEXPIRE`/re-`SET` with same value)
  so it keeps leadership; if the leader dies, the key expires in ≤15s and another
  instance takes over. (Use a check-and-renew so you only renew if you still own
  it.)
- The leader's tick iterates rooms from Redis (`rt:rooms:active` → room hashes),
  computes affordable time per payer (existing `remainingCallSeconds` logic), and
  ends calls that run out — going through the Stage-3 atomic billing claim, so
  even here a call bills once.
- Fold the **orphan sweepers** into the leader tick: end rooms whose owning
  instance's heartbeat is stale (crash cleanup), expire stale presence, fire
  expired tutor invites.

**Gotchas:**
- Even with a single leader, a call can be ended by a normal disconnect/hangup on
  a non-leader instance at the same moment the leader tries to end it — the §4
  atomic claim is what still guarantees a single charge. Do NOT rely on "only the
  leader bills"; rely on the claim. Leader election just prevents N redundant
  watchdogs, it is not the billing-safety mechanism.
- Lock value must be unique per instance (e.g. `hostname:pid:random`) so an
  instance only ever renews/releases ITS OWN leadership.

**Full staging test checklist (before ANY prod multi-instance):**
- [ ] 2+ instances behind the chosen LB with WebSocket upgrade working.
- [ ] Matchmaking pairs users across instances; blocked pairs never match; no
      double-pairing under load.
- [ ] Presence/online count consistent from every instance; ghosts expire on
      instance kill.
- [ ] Calls with participants split across instances: signaling relays, hangup
      works, peer notified.
- [ ] Billing is EXACTLY once for: normal hangup, disconnect, watchdog timeout,
      and forced disconnect+hangup races. Verify coin/second balances and the
      `Call` row.
- [ ] Tutor ring across instances: deliver, accept-once, expire-once, decline,
      cancel.
- [ ] Kill the leader instance mid-call: another takes over the watchdog within
      ~15s; no double bill, no stuck rooms.
- [ ] Rolling deploy (restart instances one at a time): calls survive because the
      other instance holds them; connection draining still finalizes cleanly.

---

## 5. Rollout order (safe path)

1. Stand up Redis; set `REDIS_URL` on the SINGLE existing instance first. Stage 1
   adapter activates but behavior is unchanged (still one instance). Confirm the
   log line flips to "Redis adapter attached".
2. Build Stages 2 → 3 → 4 → 5 → 6 in that order, each behind the same
   `REDIS_URL` flag and each keeping a single-instance-local fallback so dev
   without Redis still works.
3. Keep running ONE instance in prod through all of this. Multi-instance code
   paths are exercised in a STAGING environment with 2 instances.
4. Only after the full §Stage 6 checklist passes in staging, add the second
   prod instance behind the LB.
5. Watch billing dashboards closely for the first days after going 2-instance —
   double-charge is the failure that costs real money and trust.

---

## 6. Quick reference — files and their in-memory state

| File | In-memory state today | Stage |
| --- | --- | --- |
| `src/db/redis.js` | (client) — DONE | 1 |
| `src/realtime/socket.js` | adapter wiring — DONE | 1 |
| `src/realtime/presence.js` | `userSockets` Map | 2 |
| `src/realtime/rooms.js` | `rooms`, `socketRoom` Maps + watchdog | 3, 6 |
| `src/realtime/matchmaking.js` | `waiting` array | 4 |
| `src/realtime/tutorCalls.js` | `invites` Map + `setTimeout` timers | 5 |
| `src/realtime/lifecycle.js` | draining flag (fine as-is; per-instance) | — |

Note: the draining flag (`lifecycle.js`) can stay per-instance — each instance
drains itself on its own shutdown; no need to share it.