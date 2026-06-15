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
import { STORAGE_ROOT } from './services/storage.service.js';

const app = express();

// helmet's default Cross-Origin-Resource-Policy is "same-origin", which blocks
// the frontend (port 5173) from loading generated audio served at /static on
// port 4000. Relax it to cross-origin so <audio> can play the TTS files.
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      cb(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);
if (config.env !== 'test') app.use(morgan('dev'));

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

// Serve locally-stored audio (TTS output + recordings) in dev.
app.use('/static', express.static(STORAGE_ROOT));

app.use(config.apiPrefix, routes);

app.use(notFoundHandler);
app.use(errorHandler);

export default app;