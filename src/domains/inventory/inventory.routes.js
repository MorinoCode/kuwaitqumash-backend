import express from 'express';
import * as inventoryController from './inventory.controller.js';
import { resolveTenant } from '../../middlewares/tenant.middleware.js';
import { protect } from '../../middlewares/auth.middleware.js';
import { restrictTo } from '../../middlewares/role.middleware.js';
import { validate } from '../../middlewares/validate.middleware.js';
import { addItemBody, updateItemBody } from '../../validations/inventory.schemas.js';

const router = express.Router();

router.use(resolveTenant);
router.use(protect);

router.get('/', inventoryController.getInventory);

router.get('/custom-options', inventoryController.getCustomOptions);
router.post('/custom-options',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  inventoryController.saveCustomOption
);

router.post('/',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  (req, res, next) => {
    const body = { ...req.body };

    if (body.branch_id) body.branch_id = body.branch_id ? parseInt(body.branch_id, 10) : null;

    if (body.fabric_type === '') body.fabric_type = null;
    if (body.barcode === '') body.barcode = null;
    if (body.description === '') body.description = null;
    if (body.description_ar === '') body.description_ar = null;
    if (body.item_name === '') body.item_name = null;
    if (body.item_name_ar === '') body.item_name_ar = null;
    if (body.country_of_origin === '') body.country_of_origin = null;
    if (body.composition === '') body.composition = null;
    if (body.pattern === '') body.pattern = null;
    if (body.color === '') body.color = null;
    if (body.width_cm === '') body.width_cm = null;
    if (body.roll_length_m === '') body.roll_length_m = null;
    if (body.unit === '') delete body.unit;
    req.body = body;
    validate(addItemBody)(req, res, next);
  },
  inventoryController.addItem
);

router.get('/barcode/:barcode', inventoryController.getItemByBarcode);

router.get('/:id', inventoryController.getItemById);

router.get('/:id/check-deletable', inventoryController.checkItemDeletable);

router.put('/:id',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  (req, res, next) => {
    const body = { ...req.body };

    if (body.branch_id) body.branch_id = body.branch_id ? parseInt(body.branch_id, 10) : null;

    if (body.fabric_type === '') body.fabric_type = null;
    if (body.barcode === '') body.barcode = null;
    if (body.description === '') body.description = null;
    if (body.description_ar === '') body.description_ar = null;
    if (body.item_name === '') body.item_name = null;
    if (body.item_name_ar === '') body.item_name_ar = null;
    if (body.country_of_origin === '') body.country_of_origin = null;
    if (body.composition === '') body.composition = null;
    if (body.pattern === '') body.pattern = null;
    if (body.color === '') body.color = null;
    if (body.width_cm === '') body.width_cm = null;
    if (body.roll_length_m === '') body.roll_length_m = null;
    if (body.unit === '') delete body.unit;
    req.body = body;
    validate(updateItemBody)(req, res, next);
  },
  inventoryController.updateItem
);

router.post('/:id/dismiss-alert',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  inventoryController.dismissItemAlert
);

router.delete('/:id',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  inventoryController.deleteItem
);

export default router;
