import { Op } from "sequelize";
import WhatsappConfig from "../domains/platform/whatsapp.config.model.js";
import { cacheDelete, cacheGet, cacheSet } from "../config/redis.js";
import {
  getSessionKey,
  getWaPairedAtCacheKey,
  getWaStatusCacheKey,
} from "../queues/whatsapp.queue.js";
import logger from "./logger.js";

const STATUS_CACHE_TTL_SECONDS = 120;

export const publishWhatsAppStatusCache = async (
  tenantSlug,
  branchId = null,
  { status, is_ready, phone_connected = null, pairedAt = null },
) => {
  const sessionKey = getSessionKey(tenantSlug, branchId);
  try {
    await cacheSet(
      getWaStatusCacheKey(sessionKey),
      {
        status,
        is_ready: Boolean(is_ready),
        phone_connected: phone_connected || null,
        paired_at: pairedAt || null,
        updated_at: new Date().toISOString(),
      },
      STATUS_CACHE_TTL_SECONDS,
    );
  } catch (err) {
    logger.debug("Failed to cache WhatsApp status", {
      component: "whatsapp-status",
      sessionKey,
      error: err?.message,
    });
  }
};

export const markWhatsAppPairedNow = async (tenantSlug, branchId = null) => {
  const sessionKey = getSessionKey(tenantSlug, branchId);
  try {
    await cacheSet(
      getWaPairedAtCacheKey(sessionKey),
      Date.now(),
      7 * 24 * 60 * 60,
    );
  } catch (err) {
    logger.debug("Failed to record WhatsApp pairing timestamp", {
      component: "whatsapp-status",
      sessionKey,
      error: err?.message,
    });
  }
};

export const clearWhatsAppStatusCache = async (tenantSlug, branchId = null) => {
  const sessionKey = getSessionKey(tenantSlug, branchId);
  await cacheDelete(getWaStatusCacheKey(sessionKey));
};

export const getSessionStatusFromStore = async (tenantSlug, branchId = null) => {
  const normBranchId = branchId !== null && branchId !== undefined ? Number(branchId) : null;
  const sessionKey = getSessionKey(tenantSlug, normBranchId);

  try {
    // 1. Check direct cache for requested session (branch or central)
    const cached = await cacheGet(getWaStatusCacheKey(sessionKey));
    if (cached && cached.is_ready) {
      return {
        status: cached.status || "CONNECTED",
        is_ready: true,
        phone_connected: cached.phone_connected || null,
        is_central_fallback: false,
      };
    }

    // 2. If a specific branch was requested, check if the store's central session is ready in cache
    if (normBranchId !== null) {
      const centralKey = getSessionKey(tenantSlug, null);
      const centralCached = await cacheGet(getWaStatusCacheKey(centralKey));
      if (centralCached && centralCached.is_ready) {
        return {
          status: centralCached.status || "CONNECTED",
          is_ready: true,
          phone_connected: centralCached.phone_connected || null,
          is_central_fallback: true,
        };
      }
    }

    // 3. Check direct DB config for requested session
    const where = { tenant_slug: tenantSlug };
    if (normBranchId !== null) {
      where.branch_id = normBranchId;
    } else {
      where.branch_id = { [Op.is]: null };
    }

    const config = await WhatsappConfig.findOne({ where });
    if (config && config.session_status === "CONNECTED") {
      return {
        status: "CONNECTED",
        is_ready: Boolean(cached?.is_ready),
        phone_connected: cached?.phone_connected || null,
        is_central_fallback: false,
      };
    }

    // 4. If branch was requested and not connected in DB, fallback to central DB config
    if (normBranchId !== null) {
      const centralKey = getSessionKey(tenantSlug, null);
      const centralCached = await cacheGet(getWaStatusCacheKey(centralKey));
      const centralConfig = await WhatsappConfig.findOne({
        where: { tenant_slug: tenantSlug, branch_id: { [Op.is]: null } },
      });
      if (centralConfig && centralConfig.session_status === "CONNECTED") {
        return {
          status: "CONNECTED",
          is_ready: Boolean(centralCached?.is_ready),
          phone_connected: centralCached?.phone_connected || null,
          is_central_fallback: true,
        };
      }
    }

    if (!config) {
      return { status: "NOT_CONFIGURED", is_ready: false, phone_connected: null, is_central_fallback: false };
    }

    return {
      status: config.session_status,
      is_ready: false,
      phone_connected: cached?.phone_connected || null,
      is_central_fallback: false,
    };
  } catch (e) {
    logger.warn("getSessionStatusFromStore error", {
      component: "whatsapp-status",
      tenantSlug,
      branchId: normBranchId,
      error: e?.message,
    });
    return { status: "NOT_CONFIGURED", is_ready: false, phone_connected: null, is_central_fallback: false };
  }
};

