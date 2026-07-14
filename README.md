## API reference (prefix `/api/v1`)

### System
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/health` | — | Liveness + DB readiness (503 if Postgres unreachable) |
| GET | `/meta` | — | Supported languages, pricing, entitlement rules, ad settings |

### Auth
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/auth/register` | — | Create account (auto-login) |
| POST | `/auth/login` | — | Email/password login |
| POST | `/auth/google` | — | Google Sign-In (verifies ID token) |
| POST | `/auth/refresh` | — | Rotate tokens (reuse-detected) |
| POST | `/auth/logout` | — | Revoke a refresh token |
| POST | `/auth/email/verify/request` | ✓ | (Re)send email verification OTP |
| POST | `/auth/email/verify/confirm` | ✓ | Confirm email with OTP |
| POST | `/auth/password/forgot` | — | Send reset OTP (always 200) |
| POST | `/auth/password/reset` | — | Reset password with OTP |

### Users
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/users/me` | ✓ | Profile |
| PATCH | `/users/me` | ✓ | Update name / languages |
| DELETE | `/users/me` | ✓ | Delete account + all data (re-auth required) |
| GET | `/users/me/stats` | ✓ | Streak, counts, entitlement summary |
| GET | `/users/leaderboard` | ✓ | Top streaks |

### Cards
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/cards/feed` | opt | Daily feed (unseen-first for logged-in) |
| GET | `/cards/saved` | ✓ | Saved cards (paginated) |
| GET | `/cards/:id` | opt | Card + vocab in native language |
| POST | `/cards/:id/complete` | ✓ | Mark read/listen done → streak |
| POST | `/cards/:id/seen` | ✓ | Record view (no streak) |
| POST | `/cards/:id/save` | ✓ | Save a card |
| DELETE | `/cards/:id/save` | ✓ | Unsave a card |
| POST | `/cards/:id/speak` | ✓ | Speaking assessment (gated) — multipart `audio` |
| POST | `/cards` | admin | Create a card manually |
| POST | `/cards/generate` | admin | AI-generate a card + vocab + audio |
| POST | `/cards/article` | admin | AI-summarize a news article — multipart `image` |
| POST | `/cards/admin-article` | admin | Hand-written article card — multipart `image` |

### Speaking
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/speaking/history` | ✓ | Past attempts |
| GET | `/speaking/recordings/:id` | ✓ | Stream own recording (owner-only) |

### Ads
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/ads/admob-ssv` | — | AdMob server-side-verification callback |
| POST | `/ads/reward` | ✓ | Claim a rewarded-ad speaking credit |

### Subscription & purchases (Google Play)
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/subscription` | ✓ | Current subscription |
| POST | `/subscription/google/verify` | ✓ | Verify & activate a Play subscription |
| POST | `/subscription/cancel` | ✓ | Cancel (Play manage URL; RTDN is source of truth) |
| POST | `/purchases/google/verify` | ✓ | Verify a one-time coin pack |
| POST | `/google/rtdn/:secret` | — | Play Real-time Developer Notifications (secret + OIDC) |

### Notifications
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/notifications` | ✓ | Recent notifications + unread count |
| POST | `/notifications/read` | ✓ | Mark all read |
| POST | `/notifications/devices` | ✓ | Register a push token |
| DELETE | `/notifications/devices` | ✓ | Unregister own push token |

### Practice calls
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/calls/turn-credentials` | ✓ | Short-lived STUN/TURN ICE servers |
| GET | `/calls/history` | ✓ | Recent calls |
| GET | `/calls/balance` | ✓ | Coin / free-second balance summary |
| POST | `/calls/recharge` | ✓ | Recharge call credit (mock/dev) |
| POST | `/calls/grant-ad-video` | ✓ | Claim rewarded-ad video minutes |
| POST | `/calls/report` | ✓ | Report a call partner (also blocks) |
| POST | `/calls/block` | ✓ | Block a user |
| DELETE | `/calls/block/:userId` | ✓ | Unblock |
| GET | `/calls/blocks` | ✓ | List blocked users |

### Tutor marketplace
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/tutors/apply` | ✓ | Apply to become a tutor (email verified) |
| GET | `/tutors/me` | ✓ | Application status + earnings + payouts |
| PATCH | `/tutors/me` | ✓ | Edit profile / toggle online |
| GET | `/tutors/online` | ✓ | Reachable approved tutors |
| GET | `/tutors/admin` | admin | List applications (by status) |
| POST | `/tutors/admin/:id/approve` | admin | Approve tutor |
| POST | `/tutors/admin/:id/reject` | admin | Reject tutor |
| POST | `/tutors/admin/:id/suspend` | admin | Suspend tutor |
| POST | `/tutors/admin/:id/payouts` | admin | Record a manual UPI payout |

### Daily quiz
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/quiz/today` | ✓ | Today's quiz (no answers) |
| POST | `/quiz/answer` | ✓ | Submit an answer |
| GET | `/quiz/leaderboard` | ✓ | Monthly leaderboard + own rank |
| GET | `/quiz/me` | ✓ | Quiz streak/status |
| GET | `/quiz/winner/current` | ✓ | Claimable monthly winner offer |
| POST | `/quiz/winner/accept` | ✓ | Accept the interview offer |
| POST | `/quiz/admin/generate` | admin | Generate today's quiz |
| POST | `/quiz/admin/select-winner` | admin | Select a month's winner |
| GET | `/quiz/admin/winners` | admin | List winners |
| POST | `/quiz/admin/winners/:id/approve` | admin | Approve a winner |
| PATCH | `/quiz/admin/winners/:id` | admin | Update winner status |
| POST | `/quiz/admin/questions/:id/void` | admin | Void a bad question |

### Vocab tutor (premium)
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/vocab-tutor/status` | ✓ | Words known, due count, today's session |
| POST | `/vocab-tutor/start` | ✓ | Start/resume today's session |
| POST | `/vocab-tutor/turn` | ✓ | Submit a spoken answer / continue — multipart `audio` |
| POST | `/vocab-tutor/end` | ✓ | End session early |

### Promos & sponsored
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| POST | `/promos/google` | ✓ | Create a draft paid promo |
| POST | `/promos/:id/confirm-google` | ✓ | Confirm Play purchase → review |
| GET | `/promos/active` | opt | Live paid promos for the feed |
| GET | `/promos/mine` | ✓ | Advertiser's own promos + metrics |
| POST | `/promos/:id/impression` | ✓ | Record a unique view |
| POST | `/promos/:id/click` | opt | Record a click |
| DELETE | `/promos/:id` | ✓ | Delete own unpaid/rejected/finished promo |
| GET | `/promos/admin` | admin | Promos awaiting review |
| POST | `/promos/admin/:id/approve` | admin | Approve (go live) |
| POST | `/promos/admin/:id/reject` | admin | Reject + refund |
| GET | `/sponsored` | — | House sponsored cards |
| GET | `/sponsored/admin` | admin | All sponsored cards |
| POST | `/sponsored/admin` | admin | Create sponsored card |
| PATCH | `/sponsored/admin/:id` | admin | Update sponsored card |
| DELETE | `/sponsored/admin/:id` | admin | Delete sponsored card |

### Admin settings
| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/admin/settings` | admin | Read ad master switch + cadence |
| PATCH | `/admin/settings` | admin | Flip ads on/off, set cadence |