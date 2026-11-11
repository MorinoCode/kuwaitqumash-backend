import express from 'express';
import * as platformController from './platform.controller.js';
import { signupRateLimit } from '../../middlewares/rateLimit.middleware.js';
import { validate } from '../../middlewares/validate.middleware.js';
import { registerBody } from '../../validations/platform.schemas.js';

const router = express.Router();

router.post('/register', signupRateLimit, validate(registerBody), platformController.registerStore);

export default router;
