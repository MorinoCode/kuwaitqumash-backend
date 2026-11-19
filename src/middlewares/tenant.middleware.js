import Tenant from "../domains/platform/tenant.model.js";
import logger from "../utils/logger.js";
import {
  getCachedTenantBySlug,
  serializeTenantForCache,
  setCachedTenantBySlug,
} from "../utils/tenant-cache.js";

const SCHEMA_PATTERN = /^[a-zA-Z0-9_]+$/;
const GRACE_PERIOD_MS = 7 * 24 * 60 * 60 * 1000;
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const isAuthLifecyclePath = (req) => {
  const url = req.originalUrl || req.url || "";
  return /^\/api\/auth\/(login|logout)(\?|$)/.test(url);
};

export const evaluateSubscriptionState = (tenant, nowMs = Date.now()) => {
  if (!tenant) {
    return { allowed: false, status: 404, message: "Store not found." };
  }

  if (tenant.subscription_status !== "active") {
    return {
      allowed: false,
      status: 403,
      code: "SUBSCRIPTION_INACTIVE",
      message: "Store subscription is inactive or suspended. Please contact support.",
    };
  }

  if (!tenant.subscription_expires_at) {
    return { allowed: true, mode: "active", headers: {} };
  }

  const expiresAtMs = new Date(tenant.subscription_expires_at).getTime();
  if (Number.isNaN(expiresAtMs)) {
    return { allowed: true, mode: "active", headers: {} };
  }

  const expiresIso = new Date(expiresAtMs).toISOString();
  const graceEndsMs = expiresAtMs + GRACE_PERIOD_MS;

  if (nowMs > graceEndsMs) {
    return {
      allowed: true,
      mode: "readonly",
      headers: {
        "x-subscription-warning": "expired_readonly",
        "x-subscription-readonly": "true",
        "x-subscription-expires-at": expiresIso,
      },
      expiresAtMs,
      graceEndsMs,
    };
  }

  if (nowMs > expiresAtMs) {
    return {
      allowed: true,
      mode: "grace",
      headers: {
        "x-subscription-warning": "grace_period",
        "x-subscription-expires-at": expiresIso,
        "x-subscription-grace-ends-at": new Date(graceEndsMs).toISOString(),
      },
      expiresAtMs,
      graceEndsMs,
    };
  }

  if (expiresAtMs - nowMs <= GRACE_PERIOD_MS) {
    return {
      allowed: true,
      mode: "expiring_soon",
      headers: {
        "x-subscription-expiring-soon": "true",
        "x-subscription-expires-at": expiresIso,
      },
      expiresAtMs,
    };
  }

  return { allowed: true, mode: "active", headers: {}, expiresAtMs };
};

export const resolveTenant = async (req, res, next) => {
  const tenantSlug = req.headers["x-tenant-id"];

  if (!tenantSlug) {
    return res
      .status(400)
      .json({ message: "Tenant ID header (x-tenant-id) is missing." });
  }

  try {
    let tenant = await getCachedTenantBySlug(tenantSlug);
    if (!tenant) {
      const dbTenant = await Tenant.findOne({ where: { slug: tenantSlug } });
      if (dbTenant) {
        tenant = serializeTenantForCache(dbTenant);
        await setCachedTenantBySlug(tenant);
      }
    }

    if (!tenant) {
      return res.status(404).json({ message: "Store not found or inactive." });
    }

    if (!SCHEMA_PATTERN.test(tenant.db_schema || "")) {
      throw new Error("Invalid schema name detected.");
    }

    const subState = evaluateSubscriptionState(tenant);
    if (!subState.allowed) {
      return res.status(subState.status).json({
        message: subState.message,
        ...(subState.code ? { code: subState.code } : {}),
      });
    }

    if (typeof res.setHeader === "function") {
      for (const [header, value] of Object.entries(subState.headers || {})) {
        res.setHeader(header, value);
      }
    }

    if (
      subState.mode === "readonly" &&
      !READ_METHODS.has(req.method) &&
      !isAuthLifecyclePath(req)
    ) {
      return res.status(403).json({
        message:
          "Subscription expired. Account is in read-only mode. Please contact support to renew.",
        code: "SUBSCRIPTION_EXPIRED_READONLY",
      });
    }

    req.tenant = tenant;
    req.subscriptionState = subState;
    next();
  } catch (error) {
    logger.error("Tenant Resolution Error", {
      component: "tenant.middleware",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
      tenantSlug,
    });
    res.status(500).json({ message: "Error resolving store context." });
  }
};
