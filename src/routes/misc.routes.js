import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { adRewardSchema } from '../validators/schemas.js';
import * as speaking from '../controllers/speaking.controller.js';
import * as ads from '../controllers/ads.controller.js';
import * as sub from '../controllers/subscription.controller.js';
import * as notif from '../controllers/notification.controller.js';

import * as gpurchase from '../controllers/googlePurchase.controller.js';




const speakingRouter = Router();
speakingRouter.use(requireAuth);
speakingRouter.get('/history', speaking.getSpeakingHistory);
// Fix #3: recordings are PII — served only to their owner, never from /static.
speakingRouter.get('/recordings/:id', speaking.getRecording);

const adsRouter = Router();
adsRouter.use(requireAuth);
adsRouter.post('/reward', validate(adRewardSchema), ads.claimAdReward);

const notificationRouter = Router();
notificationRouter.use(requireAuth);
notificationRouter.get('/', notif.listNotifications);
notificationRouter.post('/read', notif.markNotificationsRead);
notificationRouter.post('/devices', notif.registerDevice);
notificationRouter.delete('/devices', notif.unregisterDevice);

const subRouter = Router();
// Payments are Google Play only. The Razorpay routes (checkout / verify /
// autopay / webhook) were removed — see subscription.controller.js for why.
subRouter.use(requireAuth);
subRouter.get('/', sub.getSubscription);
subRouter.post('/google/verify', gpurchase.verifyGoogleSubscription);
subRouter.post('/cancel', sub.cancelSubscription);

export { speakingRouter, adsRouter, subRouter, notificationRouter };