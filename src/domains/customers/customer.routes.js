import express from 'express';
import * as customerController from './customer.controller.js';
import { resolveTenant } from '../../middlewares/tenant.middleware.js';
import { protect } from '../../middlewares/auth.middleware.js';
import { upload } from '../../middlewares/upload.middleware.js';
import { restrictTo } from '../../middlewares/role.middleware.js';
import { validate } from '../../middlewares/validate.middleware.js';
import { createCustomerBody, updateCustomerBody } from '../../validations/customer.schemas.js';

const router = express.Router();

router.use(resolveTenant);
router.use(protect);

router.get('/', customerController.getCustomers);
router.get('/:id', customerController.getCustomerById);
router.get('/:id/history', customerController.getCustomerHistory);
router.get('/:id/analytics', customerController.getCustomerAnalytics);

router.post('/',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  upload.fields([{ name: 'front_image', maxCount: 1 }, { name: 'back_image', maxCount: 1 }]),
  // Validate after multer processes FormData
  (req, res, next) => {
    // Convert FormData strings to proper types for validation
    const body = { ...req.body };
    if (body.branch_id) body.branch_id = body.branch_id ? parseInt(body.branch_id, 10) : null;
    if (body.birth_date === '') body.birth_date = null;
    if (body.expiry_date === '') body.expiry_date = null;
    if (body.civil_id === '') body.civil_id = null;
    if (body.address === '') body.address = null;
    if (body.notes === '') body.notes = null;
    req.body = body;
    validate(createCustomerBody)(req, res, next);
  },
  customerController.createCustomer
);

router.put('/:id',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  upload.fields([{ name: 'front_image', maxCount: 1 }, { name: 'back_image', maxCount: 1 }]),
  validate(updateCustomerBody),
  customerController.updateCustomer
);

router.delete('/:id', 
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  customerController.deleteCustomer
);

router.post('/scan', upload.single('image'), customerController.scanIDCard);

export default router;