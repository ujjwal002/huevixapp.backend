# Huevix Backend — Security Hardening Report & Maintenance Guide

**App:** Huevix backend (Node.js + Express + Prisma + PostgreSQL)
**Server:** AWS EC2 (Ubuntu), Postgres on the same box, nginx reverse proxy, Let's Encrypt HTTPS
**Domain:** backend.huevix.com
**Date completed:** 30 June 2026

---

## 1. What this document is

This is a record of the full security review and hardening done on your backend, plus a simple routine to keep it secure going forward.

**Short version:** Your code was reviewed in detail. **No backdoors, no leaked secrets in the code, no SQL injection, no login bypass, and no broken access control were found.** The code was already well-built. One internet-facing library bug (multer) was the only real code risk, and it is now fixed. The rest of the work was hardening the *server* the code runs on, which is how small apps usually get hacked.

Everything below is now **done**. Section 6 is the part **you** need to keep doing.

---

## 2. What was checked in the audit

The whole backend was reviewed, including:

- **Authentication** — password hashing, JWT tokens, refresh-token rotation, session handling
- **Payments** — Razorpay checkout, webhooks, signature verification; Google Play purchase verification and RTDN
- **Credits / entitlements** — free trials, ad credits, call seconds, daily limits (double-spend protection)
- **File uploads** — audio recordings and images
- **Database access** — all queries (checked for SQL injection and "see other users' data" bugs)
- **Realtime calling** — WebSocket authentication and signaling
- **Secrets handling** — how API keys and passwords are stored
- **External services** — OpenAI, Azure, ElevenLabs calls
- **Dependencies** — known vulnerabilities in installed packages

### Result of the audit

| Area | Result |
|------|--------|
| Backdoors / malicious code | None found |
| Hardcoded secrets in code | None found |
| SQL injection | None (uses Prisma, safe queries) |
| Login/auth bypass | None (JWT done correctly, refresh-token reuse detection) |
| Access control (seeing others' data) | None (every query scoped to the logged-in user) |
| Payment fraud (fake/forged payments) | Protected (signatures verified, fails safe) |
| Double-spend on credits | Protected (atomic database operations) |
| Command injection / SSRF | None |
| Vulnerable dependency | **1 found: multer** (now fixed) |

**Conclusion:** No sign of compromise. The code was solid. The only real code risk was the multer library, now patched.

---

## 3. Issues found and fixed

### Fix #1 — multer file-upload vulnerability (HIGH) — FIXED

- **What:** The installed version of `multer` (the library that handles file uploads) had a known denial-of-service bug. A logged-in user could crash the server with a crafted upload.
- **Why it mattered:** It was reachable from the internet on your upload endpoints (speaking practice, article images, tutor audio).
- **Fix applied:** `npm audit fix` — upgraded multer to **2.2.0** (patched). Tests still pass; no code change needed. Change committed to git.

### Fix #2 — Google RTDN secret was being written to logs (LOW–MEDIUM) — FIXED

- **What:** The Google notification endpoint (`/google/rtdn/<secret>`) had its secret in the URL, and the production logger was logging full URLs — so the secret appeared in plain text in your server logs.
- **Fix applied (two parts):**
  1. **Rotated the secret** — generated a new one, updated `.env`, updated the Pub/Sub push endpoint URL in Google Cloud, restarted with `--update-env`. The old (exposed) secret is now dead.
  2. **Stopped logging it** — edited `src/app.js` so the logger redacts the RTDN path. Logs now show `/google/rtdn/[REDACTED]`. Change committed to git.

### Fix #3 — Google Play payments were broken (`invalid_grant`) — FIXED

- **What:** The server's Google service-account login was failing with `invalid_grant`, so Google Play purchase/subscription verification wasn't working. Paying users could have been affected.
- **Cause:** The service-account key on Google's side was no longer valid (the server clock and the key file were both fine; the key itself needed fixing in Google Cloud).
- **Fix applied:** Corrected the service account / key in Google Cloud. Verification now works.

---

## 4. Server hardening done

These are not code bugs — they protect the live server itself.

### #4.1 — Database locked to localhost — DONE
PostgreSQL listens only on `127.0.0.1:5432`, so it cannot be reached from the internet at all. Confirmed with `ss -tlnp`.

### #4.2 — Firewall (AWS Security Group) — DONE
Only ports **80 (HTTP), 443 (HTTPS), and 22 (SSH)** are open to the internet. Database port 5432 and the app port 4000 are **not** exposed.

### #4.3 — SSH hardening — DONE
- Password login: **off** (`PasswordAuthentication no`)
- Root login with password: **off** (`PermitRootLogin without-password`)
- Key-only login: **on**

This means bots cannot guess their way in; only your SSH key works.

### #4.4 — Database password rotated — DONE
The Postgres password was regenerated and updated in both Postgres and `.env`. App reconnected (`health` returns `db:ok`). The old password is dead.

### #4.5 — HTTPS — DONE
- Site loads over HTTPS; plain HTTP redirects to HTTPS (nginx, `301`).
- Certificate: valid Let's Encrypt cert.
- **Auto-renewal is active** (`certbot.timer`), so the certificate renews itself before expiry.

### #4.6 — Backups (daily + tested + off-site) — DONE
- **Daily backup** at 3 AM via cron, script at `~/backups/backup.sh`.
- Backups are compressed (`.sql.gz`), local copies kept 14 days.
- **Restore was tested** into a throwaway database — all data came back correctly (19 users verified). *A backup you have never restored is just a hope; this one is proven.*
- **Off-site copy to S3** — each backup uploads to the S3 bucket `huevix-db-backups-2026`, using an IAM role (no keys stored on the server). So losing the EC2 box does not lose your backups.

### #4.7 — Automatic OS security updates — DONE
`unattended-upgrades` is installed and **active**, so security patches install automatically.

---

## 5. Current security status — all green

| Item | Status |
|------|--------|
| #1 multer vulnerability | ✅ Patched |
| #2 RTDN secret rotated + redacted | ✅ Done |
| #3 Google Play `invalid_grant` | ✅ Fixed |
| #4.1 Database bound to localhost | ✅ Done |
| #4.2 Firewall (80/443/22 only) | ✅ Done |
| #4.3 SSH key-only, no root password | ✅ Done |
| #4.4 Database password rotated | ✅ Done |
| #4.5 HTTPS valid + auto-renewing | ✅ Done |
| #4.6 Backups: daily + tested + S3 | ✅ Done |
| #4.7 Auto OS security updates | ✅ Done |

---

## 6. What YOU need to do to keep it secure

This is the important part. None of it takes long.

### Every month (~10 minutes)

1. **Update the OS**
   ```bash
   sudo apt update && sudo apt upgrade -y
   ```
   If the kernel was updated, reboot at a quiet time: `sudo reboot`

2. **Check for vulnerable dependencies** (in the app folder)
   ```bash
   cd ~/huevixapp.backend
   npm audit
   ```
   Fix anything marked **high** or **critical** that is a *production* dependency:
   ```bash
   npm audit fix
   ```
   - Ignore dev-only tools (vitest, vite, esbuild) — they don't run on the live server.
   - After any fix: `npm test`, then `pm2 restart huevix-backend`, then commit `package.json` + `package-lock.json` to git.

3. **Confirm backups are really running** — open the S3 bucket in the AWS console and check there is a fresh `huevix_<date>.sql.gz` from the last day or two.

4. **Glance at the logs for anything strange**
   ```bash
   pm2 logs huevix-backend --lines 50
   ```
   Watch for repeated `401`/`403` spikes, or errors you don't recognize.

### Every 3 months (~10 minutes)

5. **Restore drill** — prove the backup still works by restoring into a throwaway database (this does NOT touch your live data):
   ```bash
   sudo -u postgres createdb huevix_restore_test
   LATEST=$(ls -t ~/backups/huevix_*.sql.gz | head -1)
   gunzip -c "$LATEST" | sudo -u postgres psql huevix_restore_test
   sudo -u postgres psql huevix_restore_test -c "SELECT COUNT(*) FROM \"User\";"
   sudo -u postgres dropdb huevix_restore_test
   ```
   The user count should look right. Then the test DB is deleted.

### Whenever it happens

6. **HTTPS certificate** renews itself — nothing to do. If you ever see a browser "not secure" warning, check:
   ```bash
   sudo systemctl list-timers | grep certbot
   ```

7. **If you ever rotate a secret** (DB password, JWT secret, API key) — always restart the app with the env flag so it picks up the new value:
   ```bash
   pm2 restart huevix-backend --update-env
   ```

---

## 7. Rules to stay safe (do / don't)

**DO:**
- Keep `.env` out of git (it already is — `.gitignore` lists it). Never commit it.
- Rotate any secret that ever gets shared, pasted, screenshotted, or shown to anyone.
- Restart with `--update-env` after changing any environment variable.
- Keep `MOCK_EXTERNAL=false` in production (mock mode skips payment/signature checks).
- Test (`npm test`) and watch `pm2 logs` after every change.

**DON'T:**
- Don't open port 5432 (database) or 4000 (app) in the AWS Security Group. The app talks to the DB locally; users reach the app through 80/443.
- Don't run `npm audit fix --force` — it can break your Azure speech and test setup. Only use plain `npm audit fix`.
- Don't paste real secrets (DB password, API keys) into chats, screenshots, or public places. If you do, rotate them.
- Don't change SSH settings without keeping your current session open and testing a second login first.

---

## 8. Quick reference

**Key file locations (on the server):**
- App folder: `~/huevixapp.backend`
- Environment / secrets: `~/huevixapp.backend/.env`
- Backup script: `~/backups/backup.sh`
- Local backups: `~/backups/huevix_*.sql.gz`
- Off-site backups: S3 bucket `huevix-db-backups-2026`
- Google service account key: `~/huevixapp.backend/play-service-account.json`

**Common commands:**
```bash
# Restart the app (with env reload)
pm2 restart huevix-backend --update-env

# App status and logs
pm2 status
pm2 logs huevix-backend --lines 50

# Health check (should say db:ok)
curl -s https://backend.huevix.com/api/v1/health

# Run a backup now
~/backups/backup.sh

# Check database is localhost-only
sudo ss -tlnp | grep 5432
```

**Health check meaning:**
- `{"status":"ok","db":"ok"}` = app and database are healthy
- `{"status":"degraded","db":"down"}` = app can't reach the database (usually a password mismatch in `.env`)

---

## 9. Optional improvements (not urgent)

These are nice-to-haves whenever you have time. None are required for security.

1. **S3 lifecycle rule** — in the S3 console, set old backups to auto-delete after 60–90 days, so storage stays cheap. (Currently backups in S3 are kept forever.)
2. **Production installs without dev tools** — deploy using `npm ci --omit=dev` so test tools (vitest etc.) aren't installed on the server at all. This makes `npm audit` cleaner too.
3. **Apply the 6 pending OS updates** — run `sudo apt upgrade -y` when convenient (these are normal, non-security updates that `unattended-upgrades` left for you).
4. **Stronger Google RTDN auth (advanced)** — instead of a secret in the URL, verify the Pub/Sub OIDC token (the `google-auth-library` is already installed). This is a defense-in-depth upgrade; the current setup is fine.

---

## 10. Bottom line

Your original worry was whether your backend had been hacked or could be hacked. The audit found **no signs of compromise and no backdoors**, and your code was genuinely well-built. The one real internet-facing code risk (multer) is patched, and the server is now hardened against the most common ways small production apps get breached.

Your backend is in better shape than most small production apps. Keep up the monthly routine in Section 6 and it will stay that way.

---

*End of report.*