import { OAuth2Client } from 'google-auth-library';
import { config } from '../config/env.js';
import { ApiError } from '../utils/ApiError.js';
import { withTimeout } from '../utils/withTimeout.js';

// =============================================================================
// Google Sign-In (login) — verifies the ID token the app gets from the Google
// Sign-In SDK. Distinct from Google Play billing: same Google, different keys.
//
// Security model: the ID token is a JWT signed by Google. verifyIdToken checks
// the signature against Google's rotating public certs, the expiry, AND that
// the token was minted for OUR OAuth client id(s) (the audience). Without the
// audience check, a token issued to any random app would log into ours.
//
// Mock mode accepts a JSON payload as the "token" so the flow is testable with
// zero Google setup: {"sub":"g-123","email":"a@b.com","name":"A","email_verified":true}
// =============================================================================

let _client;
function client() {
  if (!_client) _client = new OAuth2Client();
  return _client;
}

export async function verifyGoogleIdToken(idToken) {
  if (!idToken || typeof idToken !== 'string') {
    throw ApiError.badRequest('idToken is required', 'MISSING_ID_TOKEN');
  }

  if (config.mockExternal) {
    try {
      const p = JSON.parse(idToken);
      if (!p.sub || !p.email) throw new Error('mock token needs sub + email');
      return {
        googleId: String(p.sub),
        email: String(p.email).trim().toLowerCase(),
        emailVerified: p.email_verified !== false,
        name: p.name || null,
      };
    } catch {
      throw ApiError.badRequest(
        'Mock mode: idToken must be JSON like {"sub":"g-1","email":"a@b.com"}',
        'BAD_MOCK_TOKEN'
      );
    }
  }

  if (!config.googleOAuth.clientIds.length) {
    // Fail closed: real mode with no configured audience means we cannot
    // safely accept ANY token (mirrors the payment-verification policy).
    throw new ApiError(501, 'Google login is not configured on this server', 'GOOGLE_LOGIN_DISABLED');
  }

  let ticket;
  try {
    ticket = await withTimeout(
      client().verifyIdToken({ idToken, audience: config.googleOAuth.clientIds }),
      { label: 'Google ID token verification' }
    );
  } catch (e) {
    if (e instanceof ApiError) throw e; // timeout -> 503
    throw ApiError.unauthorized('Invalid Google token', 'GOOGLE_TOKEN_INVALID');
  }

  const payload = ticket.getPayload();
  if (!payload?.sub || !payload?.email) {
    throw ApiError.unauthorized('Google token missing required claims', 'GOOGLE_TOKEN_INVALID');
  }
  return {
    googleId: payload.sub,
    email: String(payload.email).trim().toLowerCase(),
    emailVerified: payload.email_verified === true,
    name: payload.name || null,
  };
}
