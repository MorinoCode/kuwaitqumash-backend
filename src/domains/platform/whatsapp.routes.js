import express from 'express';
import * as whatsappController from './whatsapp.controller.js';
import { resolveTenant } from '../../middlewares/tenant.middleware.js';
import { protect } from '../../middlewares/auth.middleware.js';
import { restrictTo } from '../../middlewares/role.middleware.js';
import { validate } from '../../middlewares/validate.middleware.js';
import { whatsappBulkBody } from '../../validations/platform.schemas.js';
import { qrRateLimit } from '../../middlewares/rateLimit.middleware.js';

const router = express.Router();

router.use(resolveTenant);
router.use(protect);

router.get('/settings', restrictTo('store_owner'), whatsappController.getSettings);
router.put('/settings', restrictTo('store_owner'), whatsappController.updateSettings);

router.get('/status', restrictTo('store_owner', 'branch_manager', 'sales_man'), whatsappController.getStatus);
router.get('/connect', restrictTo('store_owner'), qrRateLimit, whatsappController.connect);
router.post('/disconnect', restrictTo('store_owner'), whatsappController.disconnect);
router.post('/bulk', restrictTo('store_owner'), validate(whatsappBulkBody), whatsappController.sendBulk);

export default router;