import express from 'express';
import * as inventoryController from './inventory.controller.js';
import { resolveTenant } from '../../middlewares/tenant.middleware.js';
import { protect } from '../../middlewares/auth.middleware.js';
import { upload } from '../../middlewares/upload.middleware.js';
import { restrictTo } from '../../middlewares/role.middleware.js';
import { validate } from '../../middlewares/validate.middleware.js';
import { addItemBody, updateItemBody, deleteImageBody } from '../../validations/inventory.schemas.js';

const router = express.Router();

router.use(resolveTenant);
router.use(protect);

router.get('/', inventoryController.getInventory);

// Custom options routes - MUST be before /:id routes to avoid route conflict
router.get('/custom-options', inventoryController.getCustomOptions);
router.post('/custom-options',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  inventoryController.saveCustomOption
);

router.post('/',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  upload.array('images', 5),
  // Validate after multer processes FormData
  (req, res, next) => {
    // Convert FormData strings to proper types for validation
    const body = { ...req.body };
    // Convert numeric fields (only fields that are defined as number in schema)
    if (body.weight) body.weight = body.weight ? parseFloat(body.weight) : null;
    if (body.purchase_price) body.purchase_price = body.purchase_price ? parseFloat(body.purchase_price) : null;
    if (body.selling_price) body.selling_price = body.selling_price ? parseFloat(body.selling_price) : null;
    if (body.branch_id) body.branch_id = body.branch_id ? parseInt(body.branch_id, 10) : null;
    // karat is defined as string in schema, so keep it as string
    // Convert empty strings to null
    if (body.karat === '') body.karat = null;
    if (body.barcode === '') body.barcode = null;
    if (body.description === '') body.description = null;
    if (body.notes === '') body.notes = null;
    if (body.item_name === '') body.item_name = null;
    if (body.item_name_ar === '') body.item_name_ar = null;
    if (body.subcategory === '') body.subcategory = null;
    if (body.country_of_origin === '') body.country_of_origin = null;
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
  upload.array('images', 5),
  // Validate after multer processes FormData
  (req, res, next) => {
    // Convert FormData strings to proper types for validation
    const body = { ...req.body };
    // Convert numeric fields (only fields that are defined as number in schema)
    if (body.weight) body.weight = body.weight ? parseFloat(body.weight) : null;
    if (body.purchase_price) body.purchase_price = body.purchase_price ? parseFloat(body.purchase_price) : null;
    if (body.selling_price) body.selling_price = body.selling_price ? parseFloat(body.selling_price) : null;
    if (body.branch_id) body.branch_id = body.branch_id ? parseInt(body.branch_id, 10) : null;
    // karat is defined as string in schema, so keep it as string
    // Convert empty strings to null
    if (body.karat === '') body.karat = null;
    if (body.barcode === '') body.barcode = null;
    if (body.description === '') body.description = null;
    if (body.notes === '') body.notes = null;
    if (body.item_name === '') body.item_name = null;
    if (body.item_name_ar === '') body.item_name_ar = null;
    if (body.subcategory === '') body.subcategory = null;
    if (body.country_of_origin === '') body.country_of_origin = null;
    req.body = body;
    validate(updateItemBody)(req, res, next);
  },
  inventoryController.updateItem
);

router.post('/:id/delete-image',
  restrictTo('store_owner', 'branch_manager', 'sales_man'),
  validate(deleteImageBody),
  inventoryController.deleteItemImage
);

router.delete('/:id', 
  restrictTo('store_owner', 'branch_manager', 'sales_man'), 
  inventoryController.deleteItem
);

export default router;