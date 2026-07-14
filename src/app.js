import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import { config } from './config/env.js';
import routes from './routes/index.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimit.js';

import { requestId } from './middleware/requestId.js';
import { STORAGE_ROOT } from './services/storage.service.js';

import { servePrivacy } from './privacy.js';

import { serveDeleteAccount } from './deleteAccount.js';

// Mask a client IP for logging: keep enough to tell networks apart, drop enough
// that it's no longer a raw personal identifier. IPv4 (incl. IPv4-mapped IPv6)
// -> zero the last octet; IPv6 -> keep the first three hextets.
function anonymizeIp(ip) {
  if (!ip) return '-';
  const v4 = ip.includes('.') ? ip.slice(ip.lastIndexOf(':') + 1) : null;
  if (v4 && /^\d{1,3}(\.\d{1,3}){3}$/.test(v4)) {
    const parts = v4.split('.');
    parts[3] = '0';
    return parts.join('.');
  }
  if (ip.includes(':')) return ip.split(':').slice(0, 3).join(':') + '::';
  return ip;
}

const app = express();

// Behind cloudflared/ngrok (see setup.md) the socket peer is the tunnel, not
// the user. Trust the configured number of proxy hops so req.ip is the real
// client address — otherwise every request shares one IP and the per-IP rate
// limiters become a single global bucket (one attacker locks everyone out).
app.set('trust proxy', config.trustProxy);

// Correlate logs/responses with a request id (before logging so it's captured).
app.use(requestId);

// Use helmet's secure defaults (same-origin Cross-Origin-Resource-Policy). CORP
// is relaxed to cross-origin ONLY on the /static mount below, so generated TTS
// audio can be loaded by the frontend (port 5173) without weakening every
// other response.
app.use(helmet());
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      // Surface a clean 403 (not a generic 500) for disallowed origins.
      const err = new Error('Not allowed by CORS');
      err.statusCode = 403;
      err.code = 'CORS_NOT_ALLOWED';
      cb(err);
    },
    credentials: true,
  })
);
// Logging: concise 'dev' format locally; structured, request-id-tagged lines in
// production (skip the noisy /health probe).
if (config.env !== 'test') {
  if (config.env === 'production') {
    // Redact the RTDN secret (it lives in the URL path) so it never lands in logs.
    morgan.token('id', (req) => req.id);
    morgan.token('safeurl', (req) =>
      req.originalUrl.replace(/(\/google\/rtdn\/)[^/?#]+/, '$1[REDACTED]')
    );
    // Anonymize the client IP before it hits disk. Storing full IPs is PII
    // under India's DPDP Act; masking the last octet (v4) / last 80 bits (v6)
    // keeps "same network" correlation for debugging without retaining a raw
    // identifier. Handles IPv4-mapped IPv6 (::ffff:1.2.3.4) too.
    morgan.token('clientip', (req) => anonymizeIp(req.ip));
    app.use(
      morgan(':id :clientip :method :safeurl :status :res[content-length] - :response-time ms', {
        skip: (req) => req.originalUrl === `${config.apiPrefix}/health`,
      })
    );
  } else {
    app.use(morgan('dev'));
  }
}

// NOTE: the Razorpay webhook (raw-body route) that used to be mounted here was
// removed with the move to Google Play Billing. Google's equivalent is the
// RTDN push endpoint at POST /google/rtdn/:secret (routes/index.js), which
// works on parsed JSON — no raw body needed.

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(globalLimiter);

// Serve locally-stored audio (TTS output) in dev. User RECORDINGS live under
// the same root but are PII — block them here (Fix #3) so they are reachable
// only through the authenticated /speaking/recordings/:id route.
app.use('/static/recordings', (_req, res) =>
  res.status(404).json({ error: { message: 'Not found', code: 'NOT_FOUND' } })
);
app.use(
  '/static',
  (_req, res, next) => {
    // Relax CORP here (and only here) so cross-origin <audio>/<img> can load
    // the generated media. API/JSON responses keep helmet's same-origin default.
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    next();
  },
  express.static(STORAGE_ROOT)
);

// The two public HTML pages are static, script-free, and use only inline
// <style>. helmet() doesn't set a Content-Security-Policy by default, so add a
// tight one here: block ALL script (these pages have none), allow the inline
// styles they ship with, and forbid framing/plugins. Meaningful hardening with
// zero rendering impact.
const staticPageCsp = (_req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
  next();
};
app.get('/privacy', staticPageCsp, servePrivacy);
app.get('/delete-account', staticPageCsp, serveDeleteAccount);
app.use(config.apiPrefix, routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;
