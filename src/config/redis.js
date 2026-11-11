/**
 * Redis Configuration and Client
 * Provides Redis client with fallback support.
 * Redis is disabled by default. Set REDIS_ENABLED=true (and optionally REDIS_URL) to enable.
 */
import Redis from "ioredis";
import logger from "../utils/logger.js";
import { memoryCacheGet, memoryCacheSet, memoryCacheDelete, memoryCacheDeletePattern } from "../utils/memory-cache.js";

let redisClient = null;
let redisAvailable = false;

const isRedisEnabled = () =>
  process.env.REDIS_ENABLED === "true" || process.env.REDIS_ENABLED === "1";

// Initialize Redis client (only when REDIS_ENABLED=true)
const initRedis = () => {
  if (!isRedisEnabled()) return;
  try {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";

    redisClient = new Redis(redisUrl, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      lazyConnect: true,
    });

    redisClient.on("connect", () => {
      logger.info("Redis connected", { component: "redis" });
      redisAvailable = true;
    });

    redisClient.on("ready", () => {
      logger.info("Redis ready", { component: "redis" });
      redisAvailable = true;
    });

    redisClient.on("error", (err) => {
      // Don't log as error if it's a connection error (expected when Redis is not running)
      const errorMessage = err?.message || err?.code || "Unknown error";
      const errorCode = err?.code || "";

      // Connection errors (Redis not running) - log as warning
      if (
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("connect") ||
        errorMessage.includes("ENOTFOUND") ||
        errorCode === "ECONNREFUSED" ||
        errorCode === "ENOTFOUND"
      ) {
        logger.debug("Redis not available, will use database fallback", {
          component: "redis",
          error: errorMessage,
          code: errorCode,
          note: "This is normal if Redis is not installed or running. System will use database fallback.",
        });
      } else {
        // Other errors - log as error but still use fallback
        logger.error("Redis error", {
          component: "redis",
          error: errorMessage,
          code: errorCode,
          note: "System will use database fallback.",
        });
      }
      redisAvailable = false;
    });

    redisClient.on("close", () => {
      logger.debug("Redis connection closed, will use database fallback", {
        component: "redis",
        note: "System will continue working with database fallback.",
      });
      redisAvailable = false;
    });

    // Try to connect
    redisClient.connect().catch((err) => {
      const errorMessage = err?.message || err?.code || "Connection failed";
      const errorCode = err?.code || "";

      // Only log once on initial connection failure
      if (
        errorMessage.includes("ECONNREFUSED") ||
        errorMessage.includes("ENOTFOUND") ||
        errorCode === "ECONNREFUSED" ||
        errorCode === "ENOTFOUND"
      ) {
        logger.debug("Redis connection failed, will use database fallback", {
          component: "redis",
          error: errorMessage,
          code: errorCode,
          note: "This is normal if Redis is not installed or running. System will use database fallback.",
        });
      } else {
        logger.debug("Redis connection failed, will use database fallback", {
          component: "redis",
          error: errorMessage,
          code: errorCode,
        });
      }
      redisAvailable = false;
    });
  } catch (error) {
    logger.error("Redis initialization error", {
      component: "redis",
      error: error?.message,
    });
    redisAvailable = false;
  }
};

// Get Redis client (returns null if not available or Redis disabled)
export const getRedisClient = () => {
  if (!isRedisEnabled()) return null;
  if (!redisClient) {
    initRedis();
  }
  return redisAvailable ? redisClient : null;
};

// Check if Redis is available (false when Redis is disabled or not connected)
export const isRedisAvailable = () => isRedisEnabled() && redisAvailable;

// Cache helper functions - fallback to in-memory cache when Redis unavailable
export const cacheGet = async (key) => {
  const client = getRedisClient();
  if (client) {
    try {
      const data = await client.get(key);
      return data ? JSON.parse(data) : null;
    } catch (error) {
      logger.error("Redis get error", {
        component: "redis",
        key,
        error: error?.message,
      });
      // Fall through to memory cache on error
    }
  }
  // Fallback to in-memory cache when Redis not available or on error
  return memoryCacheGet(key);
};

export const cacheSet = async (key, value, ttlSeconds = 300) => {
  const client = getRedisClient();
  if (client) {
    try {
      await client.setex(key, ttlSeconds, JSON.stringify(value));
      return true;
    } catch (error) {
      logger.error("Redis set error", {
        component: "redis",
        key,
        error: error?.message,
      });
    }
  }
  // Fallback to in-memory cache when Redis not available
  memoryCacheSet(key, value, ttlSeconds);
  return true;
};

export const cacheDelete = async (key) => {
  const client = getRedisClient();
  if (client) {
    try {
      await client.del(key);
      return true;
    } catch (error) {
      logger.error("Redis delete error", {
        component: "redis",
        key,
        error: error?.message,
      });
    }
  }
  
  // Fallback to in-memory cache when Redis not available or on error
  memoryCacheDelete(key);
  return true;
};

export const cacheDeletePattern = async (pattern) => {
  const client = getRedisClient();
  if (client) {
    try {
      // Use scanStream instead of keys to avoid blocking Redis on large datasets
      const stream = client.scanStream({
        match: pattern,
        count: 100,
      });

      return new Promise((resolve) => {
        const keysToDelete = [];
        stream.on("data", (keys) => {
          if (keys.length > 0) {
            keysToDelete.push(...keys);
          }
        });
        stream.on("end", async () => {
          if (keysToDelete.length > 0) {
            // Delete in batches to avoid large payloads
            for (let i = 0; i < keysToDelete.length; i += 500) {
              const batch = keysToDelete.slice(i, i + 500);
              await client.del(...batch);
            }
          }
          resolve(true);
        });
        stream.on("error", (error) => {
          logger.error("Redis scan delete pattern error", {
            component: "redis",
            pattern,
            error: error?.message,
          });
          resolve(false);
        });
      });
    } catch (error) {
      logger.error("Redis delete pattern error", {
        component: "redis",
        pattern,
        error: error?.message,
      });
    }
  }
  
  // Fallback to in-memory cache when Redis not available
  memoryCacheDeletePattern(pattern);
  return true;
};

// Initialize on import only when Redis is enabled (no connection attempt otherwise)
if (isRedisEnabled()) {
  initRedis();
}

export default getRedisClient;
