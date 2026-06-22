import crypto from 'node:crypto';
import { config } from '../config/env.js';
import { prisma } from '../db/prisma.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/ApiError.js';

import { getCallCreditSummary, addCallSeconds } from '../services/entitlement.service.js';

import {
  createReport,
  blockUser as blockUserSvc,
  unblockUser as unblockUserSvc,
} from '../services/safety.service.js';

const REPORT_REASONS = ['HARASSMENT', 'SEXUAL_CONTENT', 'UNDERAGE', 'HATE', 'SPAM', 'OTHER'];

// GET /calls/turn-credentials  (auth)
// Returns the ICE servers the client feeds into RTCPeerConnection. TURN uses
// coturn's REST-style scheme: a short-lived username `<expiry>:<userId>` and an
// HMAC-SHA1 credential signed with the shared static secret — so no permanent
// TURN password is ever shipped in the app. STUN is always returned; TURN only
// when it's configured (in dev/mock you can run STUN-only on the same LAN).
export const getTurnCredentials = asyncHandler(async (req, res) => {
  const { stunUrls, turnUrls, turnStaticSecret, turnCredentialTtlSec } = config.realtime;

  const iceServers = [];
  if (stunUrls.length) iceServers.push({ urls: stunUrls });

  if (turnUrls.length && turnStaticSecret) {
    const expiry = Math.floor(Date.now() / 1000) + turnCredentialTtlSec;
    const username = `${expiry}:${req.user.id}`;
    const credential = crypto
      .createHmac('sha1', turnStaticSecret)
      .update(username)
      .digest('base64');
    iceServers.push({ urls: turnUrls, username, credential });
  }

  res.json({ iceServers, ttl: turnCredentialTtlSec, turnConfigured: iceServers.length > 1 });
});

// GET /calls/history  (auth) — the user's recent calls, newest first.
export const getCallHistory = asyncHandler(async (req, res) => {
  const calls = await prisma.call.findMany({
    where: { OR: [{ callerId: req.user.id }, { calleeId: req.user.id }] },
    orderBy: { startedAt: 'desc' },
    take: 20,
    include: {
      caller: { select: { id: true, name: true } },
      callee: { select: { id: true, name: true } },
    },
  });

  res.json({
    items: calls.map((c) => {
      const outgoing = c.callerId === req.user.id;
      const partner = outgoing ? c.callee : c.caller;
      return {
        id: c.id,
        type: c.type,
        status: c.status,
        direction: outgoing ? 'outgoing' : 'incoming',
        partner: { id: partner.id, name: partner.name || 'Learner' },
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        durationSec: c.durationSec,
      };
    }),
  });
});

// POST /calls/report  (auth) — report the person from a call. Body:
// { userId, callId?, reason?, note? }. Also blocks them (handled in the service).
export const reportUser = asyncHandler(async (req, res) => {
  const { userId, callId, reason, note } = req.body || {};
  if (!userId || typeof userId !== 'string') throw ApiError.badRequest('userId is required');
  if (userId === req.user.id) throw ApiError.badRequest('You cannot report yourself');

  const finalReason = REPORT_REASONS.includes(reason) ? reason : 'OTHER';
  const cleanNote = typeof note === 'string' ? note.slice(0, 1000) : undefined;

  await createReport({
    reporterId: req.user.id,
    reportedUserId: userId,
    callId: typeof callId === 'string' ? callId : undefined,
    reason: finalReason,
    note: cleanNote,
  });
  res.status(201).json({ ok: true });
});

// POST /calls/block  (auth) — body: { userId }
export const blockUser = asyncHandler(async (req, res) => {
  const { userId } = req.body || {};
  if (!userId || typeof userId !== 'string') throw ApiError.badRequest('userId is required');
  if (userId === req.user.id) throw ApiError.badRequest('You cannot block yourself');
  await blockUserSvc(req.user.id, userId);
  res.status(201).json({ ok: true });
});

// DELETE /calls/block/:userId  (auth)
export const unblockUser = asyncHandler(async (req, res) => {
  await unblockUserSvc(req.user.id, req.params.userId);
  res.json({ ok: true });
});

// GET /calls/blocks  (auth) — people the user has blocked.
export const listBlocks = asyncHandler(async (req, res) => {
  const rows = await prisma.block.findMany({
    where: { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    include: { blocked: { select: { id: true, name: true } } },
  });
  res.json({
    items: rows.map((r) => ({
      id: r.blockedUserId,
      name: r.blocked?.name || 'Learner',
      since: r.createdAt,
    })),
  });
});


// append these two handlers:
export const getCallBalance = asyncHandler(async (req, res) => {
  res.json(await getCallCreditSummary(req.user));
});

export const rechargeCall = asyncHandler(async (req, res) => {
  const { packId, seconds } = req.body || {};
  const packs = config.calls.rechargePacks;
  let grant = null;
  if (packId && Object.prototype.hasOwnProperty.call(packs, packId)) grant = packs[packId];
  else if (config.mockExternal && typeof seconds === 'number' && seconds > 0) grant = Math.round(seconds);
  if (!grant) throw ApiError.badRequest('Unknown recharge pack', 'INVALID_PACK');
  if (!config.mockExternal) {
    // TODO(payments): Razorpay order + verified-webhook credit goes here.
    throw new ApiError(501, 'Recharge payment is not configured yet', 'RECHARGE_NOT_CONFIGURED');
  }
  const balanceSeconds = await addCallSeconds(req.user.id, grant);
  res.status(201).json({ ok: true, mock: true, grantedSeconds: grant, balanceSeconds });
});
