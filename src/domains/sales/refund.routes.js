import express from "express";
import * as refundController from "./refund.controller.js";
import { resolveTenant } from "../../middlewares/tenant.middleware.js";
import { protect } from "../../middlewares/auth.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import { createRefundBody } from "../../validations/refund.schemas.js";

const router = express.Router();

router.use(resolveTenant);
router.use(protect);

router.get("/invoices/:id/for-refund", refundController.getInvoiceForRefund);
router.get("/:id/pdf", refundController.getCreditNotePDF);
router.post("/", validate(createRefundBody), refundController.createRefund);
router.get("/", refundController.getRefunds);

export default router;
