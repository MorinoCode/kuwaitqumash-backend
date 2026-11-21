import express from 'express';
import * as platformController from './platform.controller.js';
import { signupRateLimit, contactRateLimit } from '../../middlewares/rateLimit.middleware.js';
import { validate } from '../../middlewares/validate.middleware.js';
import { registerBody, contactMessageBody } from '../../validations/platform.schemas.js';

const router = express.Router();

router.post('/register', signupRateLimit, validate(registerBody), platformController.registerStore);

router.post('/contact', contactRateLimit, validate(contactMessageBody), platformController.submitContactMessage);

export default router;
