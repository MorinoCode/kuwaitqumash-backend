import path from "path";
import WhatsappConfig from "../domains/platform/whatsapp.config.model.js";
import logger from "./logger.js";
import {
  cacheSet,
  cacheDelete,
  getRedisClient,
} from "../config/redis.js";
import {
  getSessionStatusFromStore,
  publishWhatsAppStatusCache,
} from "./whatsapp-status.js";

const REDIS_SESSION_PREFIX = "whatsapp:session:";
const REDIS_SESSIONS_SET = "whatsapp:sessions:active";

const getRedisSessionKey = (sessionKey) =>
  `${REDIS_SESSION_PREFIX}${sessionKey}`;

export const saveSessionToRedis = async (sessionKey, sessionData) => {
  try {
    await cacheSet(getRedisSessionKey(sessionKey), sessionData, 3600);
    const client = getRedisClient();
    if (client) {
      await client.sadd(REDIS_SESSIONS_SET, sessionKey);
    }
  } catch (error) {
    logger.warn("Failed to save session to Redis", {
      component: "whatsapp",
      sessionKey,
      error: error?.message,
    });
  }
};

export const deleteSessionFromRedis = async (sessionKey) => {
  try {
    await cacheDelete(getRedisSessionKey(sessionKey));
    const client = getRedisClient();
    if (client) {
      await client.srem(REDIS_SESSIONS_SET, sessionKey);
    }
  } catch (error) {
    logger.warn("Failed to delete session from Redis", {
      component: "whatsapp",
      sessionKey,
      error: error?.message,
    });
  }
};

export const sessions = new Map();
export const sessionLastActivity = new Map();
const MAX_ACTIVE_SESSIONS = Number(process.env.WHATSAPP_MAX_ACTIVE_SESSIONS) || 40;
const IDLE_SESSION_TTL_MS = Number(process.env.WHATSAPP_IDLE_SESSION_TTL_MS) || 0;

export const touchSession = (sessionKey) => {
  sessionLastActivity.set(sessionKey, Date.now());
};

export const evictOldestSessionIfNeeded = async (incomingKey) => {
  if (sessions.has(incomingKey) || sessions.size < MAX_ACTIVE_SESSIONS) {
    return;
  }

  let oldestKey = null;
  let oldestTs = Infinity;
  for (const key of sessions.keys()) {
    if (key === incomingKey) continue;
    const ts = sessionLastActivity.get(key) || 0;
    if (ts < oldestTs) {
      oldestTs = ts;
      oldestKey = key;
    }
  }

  if (oldestKey) {
    const oldSock = sessions.get(oldestKey);
    try {
      oldSock?.end?.(new Error("Evicted due to active session RAM cap"));
    } catch {
      // Ignore socket close errors during LRU eviction
    }
    sessions.delete(oldestKey);
    sessionLastActivity.delete(oldestKey);
    logger.warn("Evicted least-recently-used WhatsApp session to stay under RAM cap", {
      component: "whatsapp",
      evictedSession: oldestKey,
      maxActiveSessions: MAX_ACTIVE_SESSIONS,
    });
  }
};

const getSessionsBaseDir = () =>
  process.env.WA_AUTH_DIR ||
  process.env.WHATSAPP_SESSIONS_DIR ||
  path.join(process.cwd(), "whatsapp_sessions");

export const getSessionDir = (sessionKey) => path.join(getSessionsBaseDir(), sessionKey);

export const getSessionKey = (tenantSlug, branchId = null) => {
  return branchId ? `${tenantSlug}_branch_${branchId}` : tenantSlug;
};

export const cleanupDisconnectedSessions = async () => {
  try {
    const disconnectedSessions = [];
    const allSessionKeys = new Set();

    try {
      const client = getRedisClient();
      if (client) {
        const redisSessions = await client.smembers(REDIS_SESSIONS_SET);
        redisSessions.forEach((key) => allSessionKeys.add(key));
      }
    } catch (redisError) {
      void redisError;
      logger.debug("Failed to get sessions from Redis, using memory only", {
        component: "whatsapp",
      });
    }

    sessions.forEach((_, key) => allSessionKeys.add(key));

    // Fetch all CONNECTED session configs in a single query instead of N+1 per session
    const connectedConfigs = await WhatsappConfig.findAll({
      where: { session_status: "CONNECTED" },
      attributes: ["tenant_slug", "branch_id"],
      raw: true,
    });
    const connectedKeySet = new Set(
      connectedConfigs.map((cfg) => getSessionKey(cfg.tenant_slug, cfg.branch_id)),
    );

    for (const sessionKey of allSessionKeys) {
      let isDisconnected = false;

      const sock = sessions.get(sessionKey);
      const lastActive = sessionLastActivity.get(sessionKey) || 0;
      const isIdleExpired =
        IDLE_SESSION_TTL_MS > 0 &&
        lastActive > 0 &&
        Date.now() - lastActive > IDLE_SESSION_TTL_MS;

      if (!sock || !sock.user || !connectedKeySet.has(sessionKey) || isIdleExpired) {
        isDisconnected = true;
      }

      if (isDisconnected) {
        disconnectedSessions.push(sessionKey);
      }
    }

    for (const sessionKey of disconnectedSessions) {
      const sock = sessions.get(sessionKey);
      if (sock) {
        try {
          await sock.end();
        } catch (e) {
          logger.warn("Error ending socket during cleanup", {
            component: "whatsapp",
            sessionKey,
            error: e?.message,
          });
        }
      }
      sessions.delete(sessionKey);
      sessionLastActivity.delete(sessionKey);
      await deleteSessionFromRedis(sessionKey);
      logger.info("Cleaned up disconnected session", {
        component: "whatsapp",
        sessionKey,
      });
    }

    if (disconnectedSessions.length > 0) {
      logger.info("WhatsApp session cleanup completed", {
        component: "whatsapp",
        cleaned: disconnectedSessions.length,
        remaining: sessions.size,
      });
    }
  } catch (error) {
    logger.error("WhatsApp session cleanup error", {
      component: "whatsapp",
      error: error?.message,
    });
  }
};

export const refreshActiveSessionStatuses = async () => {
  for (const [sessionKey, sock] of sessions.entries()) {
    if (!sock?.user) continue;
    const branchMatch = /^(.*)_branch_(\d+)$/.exec(sessionKey);
    const tenantSlug = branchMatch ? branchMatch[1] : sessionKey;
    const branchId = branchMatch ? Number.parseInt(branchMatch[2], 10) : null;
    const uid = sock.user?.id;
    const phone = typeof uid === "string" ? uid.split(":")[0] : null;
    await publishWhatsAppStatusCache(tenantSlug, branchId, {
      status: "CONNECTED",
      is_ready: true,
      phone_connected: phone,
    });
  }
};

export const closeAllWhatsAppSockets = async () => {
  for (const [sessionKey, sock] of sessions.entries()) {
    try {
      sock?.end?.(new Error("Worker shutdown"));
    } catch {
      // Ignore socket close errors on shutdown
    }
    sessions.delete(sessionKey);
    sessionLastActivity.delete(sessionKey);
  }
};

export const getSessionStatus = async (tenantSlug, branchId = null) => {
  try {
    const normBranchId =
      branchId !== null && branchId !== undefined ? Number(branchId) : null;
    const sessionKey = getSessionKey(tenantSlug, normBranchId);
    const session = sessions.get(sessionKey);
    const uid = session?.user?.id;
    const phone = typeof uid === "string" ? uid.split(":")[0] : null;
    if (session?.user) {
      return {
        status: "CONNECTED",
        is_ready: true,
        phone_connected: phone || null,
        is_central_fallback: false,
      };
    }

    if (normBranchId !== null) {
      const centralKey = getSessionKey(tenantSlug, null);
      const centralSession = sessions.get(centralKey);
      const centralUid = centralSession?.user?.id;
      const centralPhone =
        typeof centralUid === "string" ? centralUid.split(":")[0] : null;
      if (centralSession?.user) {
        return {
          status: "CONNECTED",
          is_ready: true,
          phone_connected: centralPhone || null,
          is_central_fallback: true,
        };
      }
    }

    return await getSessionStatusFromStore(tenantSlug, normBranchId);
  } catch (e) {
    logger.warn("getSessionStatus error", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      error: e?.message,
    });
    return {
      status: "NOT_CONFIGURED",
      is_ready: false,
      phone_connected: null,
      is_central_fallback: false,
    };
  }
};

export const getSocket = (tenantSlug, branchId = null) => {
  const normBranchId =
    branchId !== null && branchId !== undefined ? Number(branchId) : null;
  const sessionKey = getSessionKey(tenantSlug, normBranchId);
  let sock = sessions.get(sessionKey);

  if ((!sock || !sock.user) && normBranchId !== null) {
    const centralKey = getSessionKey(tenantSlug, null);
    const centralSock = sessions.get(centralKey);
    if (centralSock && centralSock.user) {
      return centralSock;
    }
  }

  if (!sock) {
    logger.warn("Socket not found in sessions", {
      component: "whatsapp",
      tenantSlug,
      branchId: normBranchId,
      sessionKey,
      availableSessions: Array.from(sessions.keys()),
    });
    return null;
  }

  if (!sock.user) {
    logger.warn("Socket exists but user not authenticated", {
      component: "whatsapp",
      tenantSlug,
      branchId: normBranchId,
      sessionKey,
      socketExists: true,
      hasUser: false,
    });
    return null;
  }

  logger.info("Socket found and ready", {
    component: "whatsapp",
    tenantSlug,
    branchId: normBranchId,
    sessionKey,
    userId: sock.user?.id,
  });

  return sock;
};
