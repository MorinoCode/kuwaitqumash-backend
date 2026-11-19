import express from "express";
import * as adminController from "./admin.controller.js";
import { protectAdmin } from "./admin.middleware.js";
import { adminLoginRateLimit } from "../../middlewares/rateLimit.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import {
  adminBranchBody,
  adminLoginBody,
  createTenantBody,
  updateTenantBody,
} from "../../validations/admin.schemas.js";

const router = express.Router();

router.post(
  "/login",
  adminLoginRateLimit,
  validate(adminLoginBody),
  adminController.login,
);
router.post("/logout", adminController.logout);

router.use(protectAdmin);

router.get("/me", adminController.getMe);

router.get("/tenants", adminController.listTenants);
router.post("/tenants", validate(createTenantBody), adminController.createTenant);
router.get("/tenants/:id", adminController.getTenantById);
router.put(
  "/tenants/:id",
  validate(updateTenantBody),
  adminController.updateTenant,
);
router.delete("/tenants/:id", adminController.deleteTenant);

router.get("/tenants/:id/branches", adminController.listTenantBranches);
router.post(
  "/tenants/:id/branches",
  validate(adminBranchBody),
  adminController.createTenantBranch,
);
router.put(
  "/tenants/:id/branches/:branchId",
  validate(adminBranchBody),
  adminController.updateTenantBranch,
);
router.delete(
  "/tenants/:id/branches/:branchId",
  adminController.deleteTenantBranch,
);

router.get("/tenants/:id/inventory", adminController.listTenantInventory);
router.get("/tenants/:id/invoices", adminController.listTenantInvoices);
router.get("/tenants/:id/customers", adminController.listTenantCustomers);
router.get("/tenants/:id/users", adminController.listTenantUsers);
router.put(
  "/tenants/:id/users/:userId/password",
  adminController.updateTenantUserPassword,
);
router.post(
  "/tenants/:id/reset-password",
  adminController.resetTenantPassword,
);

router.get("/contact-messages", adminController.listContactMessages);
router.patch("/contact-messages/:id", adminController.markContactMessageRead);
router.delete("/contact-messages/:id", adminController.deleteContactMessage);

export default router;

