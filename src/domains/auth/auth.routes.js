// domains/auth/auth.routes.js
import express from 'express';
import * as authController from './auth.controller.js';
import { resolveTenant } from '../../middlewares/tenant.middleware.js';
import { protect } from '../../middlewares/auth.middleware.js';
import { loginRateLimit } from '../../middlewares/rateLimit.middleware.js';
import { validate } from '../../middlewares/validate.middleware.js';
import { loginBody } from '../../validations/auth.schemas.js';

const router = express.Router();

// Security: Apply rate limiting and validation to login endpoint
router.post('/login', loginRateLimit, resolveTenant, validate(loginBody), authController.login);

router.post('/logout', authController.logout);

router.get('/me', resolveTenant, protect, authController.getMe);

export default router;