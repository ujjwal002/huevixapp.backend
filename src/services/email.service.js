import crypto from 'node:crypto';
import { prisma } from '../db/prisma.js';
import { config } from '../config/env.js';
import { withTimeout } from '../utils/withTimeout.js';
import { timingSafeEqualStr } from '../utils/crypto.js';

// =============================================================================
// Outbound email + OTP lifecycle (email verification & password reset).
//
// Model: 6-digit one-time codes, because the app is mobile-first and typing a
// code beats tapping an emailed link. Only sha256(code) is stored; issuing a
// new code invalidates older ones of the same type; a code burns after
// config.email.otpMaxAttempts wrong guesses or config.email.otpTtlMinutes.
//
// Transport priority:
//   1. Resend HTTP API   — set RESEND_API_KEY (simplest, recommended)
//   2. Plain SMTP        — set SMTP_HOST/... (works with any provider,
//                          including Resend's own smtp.resend.com)
//   3. Mock              — mock mode or nothing configured: the code is logged
//                          to the console, so the flow is testable with zero setup.
// =============================================================================

let _transport;
async function getTransport() {
  if (_transport) return _transport;
  const { default: nodemailer } = await import('nodemailer');
  _transport = nodemailer.createTransport({
    host: config.email.host,
    port: config.email.port,
    secure: config.email.secure,
    auth: config.email.user ? { user: config.email.user, pass: config.email.pass } : undefined,
  });
  return _transport;
}

async function sendViaResend({ to, subject, text }) {
  const res = await withTimeout(
    fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.email.resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: config.email.from, to: [to], subject, text }),
    }),
    { label: 'Resend send' }
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`Resend send failed: ${res.status} ${detail.slice(0, 300)}`);
  }
  return { sent: true, provider: 'resend' };
}

async function sendMail({ to, subject, text }) {
  // Console-log path is DEV ONLY. It prints the OTP, so it must never run in
  // production — otherwise a prod deploy that forgot to configure an email
  // transport would leak reset/verification codes into plaintext logs.
  if (
    config.env !== 'production' &&
    (config.mockExternal || (!config.email.resendApiKey && !config.email.host))
  ) {
    console.log(`[email:mock] to=${to} subject="${subject}"\n${text}`);
    return { mock: true };
  }
  if (config.email.resendApiKey) return sendViaResend({ to, subject, text });
  if (config.email.host) {
    const transport = await getTransport();
    await withTimeout(transport.sendMail({ from: config.email.from, to, subject, text }), {
      label: 'SMTP send',
    });
    return { sent: true, provider: 'smtp' };
  }
  // Production with no transport configured: fail loudly rather than silently
  // dropping (or logging) the code.
  throw new Error('No email transport configured (set RESEND_API_KEY or SMTP_HOST)');
}

const hashCode = (code) => crypto.createHash('sha256').update(String(code)).digest('hex');

// Issue a fresh OTP of `type` for the user, invalidating any previous live
// codes of the same type (exactly one valid code at a time), and email it.
export async function issueOtp(user, type) {
  // crypto-random 6 digits, no modulo bias worth caring about at this range.
  const code = String(crypto.randomInt(100000, 1000000));
  const expiresAt = new Date(Date.now() + config.email.otpTtlMinutes * 60 * 1000);

  await prisma.$transaction([
    prisma.emailToken.updateMany({
      where: { userId: user.id, type, usedAt: null },
      data: { usedAt: new Date() }, // retire older codes
    }),
    prisma.emailToken.create({
      data: { userId: user.id, type, codeHash: hashCode(code), expiresAt },
    }),
  ]);

  const subject =
    type === 'VERIFY_EMAIL' ? 'Verify your Huevix email' : 'Reset your Huevix password';
  const action = type === 'VERIFY_EMAIL' ? 'verify your email address' : 'reset your password';
  await sendMail({
    to: user.email,
    subject,
    text:
      `Your Huevix code is: ${code}\n\n` +
      `Enter it in the app to ${action}. It expires in ${config.email.otpTtlMinutes} minutes.\n\n` +
      `If you didn't request this, you can ignore this email.`,
  });
}

// Verify a submitted code. Consumes the token on success; counts (and caps)
// wrong attempts so a code can't be brute-forced within its TTL window.
// Returns { ok } or { ok: false, reason }.
export async function verifyOtp(userId, type, code) {
  const token = await prisma.emailToken.findFirst({
    where: { userId, type, usedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: 'desc' },
  });
  if (!token) return { ok: false, reason: 'CODE_EXPIRED' };

  if (!timingSafeEqualStr(token.codeHash, hashCode(code))) {
    const bumped = await prisma.emailToken.update({
      where: { id: token.id },
      data: { attempts: { increment: 1 } },
    });
    if (bumped.attempts >= config.email.otpMaxAttempts) {
      await prisma.emailToken.update({
        where: { id: token.id },
        data: { usedAt: new Date() }, // burn it
      });
      return { ok: false, reason: 'TOO_MANY_ATTEMPTS' };
    }
    return { ok: false, reason: 'CODE_INVALID' };
  }

  // Correct: single-use. The conditional update closes the race where two
  // requests submit the same code concurrently — only one consumes it.
  const consumed = await prisma.emailToken.updateMany({
    where: { id: token.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  if (consumed.count !== 1) return { ok: false, reason: 'CODE_EXPIRED' };
  return { ok: true };
}
