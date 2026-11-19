import { cacheDeletePattern } from "../config/redis.js";
import logger from "./logger.js";

/**
 * Drops cached dashboard/analytics payloads for one store.
 * Called after a sale or refund so the dashboard reflects new data
 * immediately instead of waiting for the cache TTL.
 */
export const invalidateDashboardCache = async (tenantSlug) => {
  if (!tenantSlug) return;

  try {
    await cacheDeletePattern(`dashboard:*:${tenantSlug}*`);
    await cacheDeletePattern(`analytics:${tenantSlug}*`);
  } catch (error) {
    logger.warn("Dashboard cache invalidation failed", {
      component: "dashboard-cache",
      tenant: tenantSlug,
      error: error?.message,
    });
  }
};
