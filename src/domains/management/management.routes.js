import express from "express";
import * as manageController from "./management.controller.js";
import { resolveTenant } from "../../middlewares/tenant.middleware.js";
import { protect } from "../../middlewares/auth.middleware.js";
import { restrictTo } from "../../middlewares/role.middleware.js";
import { validate } from "../../middlewares/validate.middleware.js";
import {
  upload,
  validateImageContent,
} from "../../middlewares/upload.middleware.js";
import {
  createBranchBody,
  updateBranchBody,
  createStaffBody,
  updateStaffBody,
} from "../../validations/management.schemas.js";

const router = express.Router();

router.use(resolveTenant);
router.use(protect);

// --- Branch Routes ---
router.get(
  "/branches",
  restrictTo("store_owner", "branch_manager", "sales_man"),
  manageController.getBranches,
);
router.get(
  "/branches/:id",
  restrictTo("store_owner", "branch_manager", "sales_man"),
  manageController.getBranchById,
);

router.post(
  "/branches",
  restrictTo("store_owner"),
  validate(createBranchBody),
  manageController.createBranch,
);
router.put(
  "/branches/:id",
  restrictTo("store_owner", "branch_manager", "sales_man"),
  validate(updateBranchBody),
  manageController.updateBranch,
);
router.post(
  "/branches/:id/logo",
  restrictTo("store_owner", "branch_manager"),
  upload.single("logo"),
  validateImageContent,
  manageController.uploadBranchLogo,
);
router.delete(
  "/branches/:id/logo",
  restrictTo("store_owner", "branch_manager"),
  manageController.deleteBranchLogo,
);
router.delete(
  "/branches/:id",
  restrictTo("store_owner"),
  manageController.deleteBranch,
);

// --- Staff Routes ---
router.get(
  "/staff",
  restrictTo("store_owner", "branch_manager"),
  manageController.getStaff,
);
router.get(
  "/staff/:id",
  restrictTo("store_owner", "branch_manager"),
  manageController.getStaffById,
);
router.get(
  "/staff/:id/analytics",
  restrictTo("store_owner", "branch_manager"),
  manageController.getStaffAnalytics,
);
router.post(
  "/staff",
  restrictTo("store_owner", "branch_manager"),
  validate(createStaffBody),
  manageController.createStaff,
);
router.put(
  "/staff/:id",
  restrictTo("store_owner", "branch_manager"),
  validate(updateStaffBody),
  manageController.updateStaff,
);
router.delete(
  "/staff/:id",
  restrictTo("store_owner", "branch_manager"),
  manageController.deleteStaff,
);

export default router;
