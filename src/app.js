import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import path from 'node:path';
import { config } from './config/env.js';
import routes from './routes/index.js';
import { webhook } from './controllers/subscription.controller.js';
import { notFoundHandler, errorHandler } from './middleware/errorHandler.js';
import { globalLimiter } from './middleware/rateLimit.js';

import { requestId } from './middleware/requestId.js';
import { STORAGE_ROOT } from './services/storage.service.js';

import { servePrivacy } from './privacy.js';

import { serveDeleteAccount } from './deleteAccount.js';

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
    app.use(
      morgan(':id :remote-addr :method :safeurl :status :res[content-length] - :response-time ms', {
        skip: (req) => req.originalUrl === `${config.apiPrefix}/health`,
      })
    );
  } else {
    app.use(morgan('dev'));
  }
}

// Razorpay webhook MUST receive the raw body for signature verification, so it
// is mounted BEFORE the JSON body parser, with its own raw parser.
app.post(
  `${config.apiPrefix}/subscription/webhook`,
  express.raw({ type: 'application/json' }),
  (req, _res, next) => {
    req.rawBody = req.body; // Buffer
    try {
      req.body = JSON.parse(req.body.toString('utf-8') || '{}');
    } catch {
      req.body = {};
    }
    next();
  },
  webhook
);

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



app.get('/privacy', servePrivacy);
app.get('/delete-account', serveDeleteAccount);
app.use(config.apiPrefix, routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;