import express from 'express';
import {
  getOwnerDashboard,
  getManagerDashboard,
  getSalesmanDashboard,
  getDashboardAnalytics,
  getTopItems,
} from './dashboard.controller.js';
import { protect, restrictTo } from '../../middlewares/auth.middleware.js';
import { resolveTenant } from '../../middlewares/tenant.middleware.js';

const router = express.Router();

router.use(resolveTenant);
router.use(protect);

router.get('/owner', restrictTo('store_owner'), getOwnerDashboard);
router.get('/manager', restrictTo('branch_manager'), getManagerDashboard);
router.get('/salesman', restrictTo('sales_man'), getSalesmanDashboard);

router.get('/analytics', getDashboardAnalytics);
router.get('/top-items', getTopItems);

export default router;
