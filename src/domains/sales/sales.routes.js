import express from 'express';
import * as salesController from './sales.controller.js';
import { resolveTenant } from '../../middlewares/tenant.middleware.js';
import { protect } from '../../middlewares/auth.middleware.js';
import { validate } from '../../middlewares/validate.middleware.js';
import { createSaleBody } from '../../validations/sales.schemas.js';

const router = express.Router();

router.use(resolveTenant);
router.use(protect);

router.post('/create', validate(createSaleBody), salesController.createSale);

router.get('/invoices', salesController.getInvoices);
router.get('/invoices/:id/pdf', salesController.getInvoicePDF);
router.post('/invoices/:id/send-whatsapp', salesController.sendInvoiceWhatsApp);
router.get('/report/excel', salesController.downloadSalesExcel);
router.get('/:id', salesController.getInvoiceById);

export default router;