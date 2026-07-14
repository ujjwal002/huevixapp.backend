import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { authLimiter, emailLimiter } from '../middleware/rateLimit.js';
import { validate } from '../middleware/validate.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  googleLoginSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
} from '../validators/schemas.js';
import * as auth from '../controllers/auth.controller.js';

const router = Router();

router.post('/register', authLimiter, validate(registerSchema), auth.register);
router.post('/login', authLimiter, validate(loginSchema), auth.login);
router.post('/google', authLimiter, validate(googleLoginSchema), auth.googleLogin);
router.post('/refresh', validate(refreshSchema), auth.refresh);
router.post('/logout', auth.logout);

// Email verification (auth: we know who's asking; codes go to their own email)
router.post('/email/verify/request', requireAuth, emailLimiter, auth.requestEmailVerification);
router.post(
  '/email/verify/confirm',
  requireAuth,
  authLimiter,
  validate(verifyEmailSchema),
  auth.confirmEmailVerification
);

// Password reset (unauthenticated by nature; heavily rate-limited)
router.post('/password/forgot', emailLimiter, validate(forgotPasswordSchema), auth.forgotPassword);
router.post('/password/reset', authLimiter, validate(resetPasswordSchema), auth.resetPassword);

export default router;
