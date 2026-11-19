import { cacheDelete, cacheGet, cacheSet } from "../config/redis.js";
import logger from "./logger.js";

export const TENANT_CACHE_TTL_SECONDS = 300;
const getTenantCacheKey = (slug) => `tenant:slug:${slug}`;

export const serializeTenantForCache = (tenant) => {
  if (!tenant) return null;
  const plain = typeof tenant.toJSON === "function" ? tenant.toJSON() : tenant;
  return {
    id: plain.id,
    name: plain.name,
    slug: plain.slug,
    db_schema: plain.db_schema,
    owner_name: plain.owner_name,
    phone: plain.phone,
    subscription_status: plain.subscription_status,
    subscription_expires_at: plain.subscription_expires_at || null,
  };
};

export const getCachedTenantBySlug = async (slug) => {
  if (!slug) return null;
  try {
    return await cacheGet(getTenantCacheKey(slug));
  } catch (error) {
    logger.warn("Failed to read tenant cache", {
      component: "tenant-cache",
      slug,
      error: error?.message,
    });
    return null;
  }
};

export const setCachedTenantBySlug = async (tenant) => {
  const payload = serializeTenantForCache(tenant);
  if (!payload?.slug) return;
  try {
    await cacheSet(
      getTenantCacheKey(payload.slug),
      payload,
      TENANT_CACHE_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn("Failed to write tenant cache", {
      component: "tenant-cache",
      slug: payload.slug,
      error: error?.message,
    });
  }
};

export const invalidateTenantCache = async (slug) => {
  if (!slug) return;
  try {
    await cacheDelete(getTenantCacheKey(slug));
  } catch (error) {
    logger.warn("Failed to invalidate tenant cache", {
      component: "tenant-cache",
      slug,
      error: error?.message,
    });
  }
};

