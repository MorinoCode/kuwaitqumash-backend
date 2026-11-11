/**
 * Rate limiter for login and signup endpoints
 * Uses Redis for storage with memory fallback
 */

import {
  cacheGet,
  cacheSet,
  getRedisClient,
} from "../config/redis.js";
import logger from "../utils/logger.js";

// Redis keys
const REDIS_RATE_LIMIT_PREFIX = "rate_limit:";
const REDIS_RATE_LIMIT_SET = "rate_limit:keys";

// In-memory fallback is removed as it causes memory leaks and is ineffective in multi-pod environments

// Helper functions
const getRedisRateLimitKey = (type, key) =>
  `${REDIS_RATE_LIMIT_PREFIX}${type}:${key}`;

const getRateLimitFromRedis = async (type, key) => {
  try {
    const redisKey = getRedisRateLimitKey(type, key);
    return await cacheGet(redisKey);
  } catch (error) {
    void error;
    logger.warn("Failed to get rate limit from Redis", {
      component: "rateLimit",
      type,
      key,
    });
    return null;
  }
};

const setRateLimitToRedis = async (type, key, value, ttlSeconds) => {
  try {
    const redisKey = getRedisRateLimitKey(type, key);
    await cacheSet(redisKey, value, ttlSeconds);
    const client = getRedisClient();
    if (client) {
      await client.sadd(REDIS_RATE_LIMIT_SET, redisKey);
    }
  } catch (error) {
    void error;
    logger.warn("Failed to set rate limit to Redis", {
      component: "rateLimit",
      type,
      key,
    });
  }
};


// (Cleanup intervals removed - Redis TTL handles this automatically)

export const loginRateLimit = async (req, res, next) => {
  // Use IP address + username as key for rate limiting
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const username = req.body?.username || "unknown";
  const key = `${ip}:${username}`;

  const now = Date.now();
  const MAX_ATTEMPTS = 5;
  const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

  // Use Redis for distributed rate limiting
  let attempt = await getRateLimitFromRedis("login", key);

  if (!attempt) {
    // First attempt
    const newAttempt = {
      count: 1,
      firstAttempt: now,
      lastAttempt: now,
    };
    await setRateLimitToRedis(
      "login",
      key,
      newAttempt,
      Math.ceil(WINDOW_MS / 1000)
    );
    return next();
  }

  // Reset if window expired
  if (now - attempt.firstAttempt > WINDOW_MS) {
    const newAttempt = {
      count: 1,
      firstAttempt: now,
      lastAttempt: now,
    };
    await setRateLimitToRedis(
      "login",
      key,
      newAttempt,
      Math.ceil(WINDOW_MS / 1000)
    );
    return next();
  }

  // Check if exceeded limit
  if (attempt.count >= MAX_ATTEMPTS) {
    const remainingTime = Math.ceil(
      (WINDOW_MS - (now - attempt.firstAttempt)) / 1000 / 60
    );
    return res.status(429).json({
      message: `Too many login attempts. Please try again in ${remainingTime} minute(s).`,
    });
  }

  // Increment attempt count
  attempt.count++;
  attempt.lastAttempt = now;
  await setRateLimitToRedis("login", key, attempt, Math.ceil(WINDOW_MS / 1000));

  next();
};

// Rate limiter for signup endpoint
export const signupRateLimit = async (req, res, next) => {
  // Use IP address as key for rate limiting
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const key = ip;

  const now = Date.now();
  const isProduction = process.env.NODE_ENV === "production";
  const MAX_ATTEMPTS = isProduction ? 3 : 30;
  const WINDOW_MS = isProduction ? 60 * 60 * 1000 : 15 * 60 * 1000; // prod: 1h, dev: 15min

  // Use Redis for distributed rate limiting
  let attempt = await getRateLimitFromRedis("signup", key);

  if (!attempt) {
    // First attempt
    const newAttempt = {
      count: 1,
      firstAttempt: now,
      lastAttempt: now,
    };
    await setRateLimitToRedis(
      "signup",
      key,
      newAttempt,
      Math.ceil(WINDOW_MS / 1000)
    );
    return next();
  }

  // Reset if window expired
  if (now - attempt.firstAttempt > WINDOW_MS) {
    const newAttempt = {
      count: 1,
      firstAttempt: now,
      lastAttempt: now,
    };
    await setRateLimitToRedis(
      "signup",
      key,
      newAttempt,
      Math.ceil(WINDOW_MS / 1000)
    );
    return next();
  }

  // Check if exceeded limit
  if (attempt.count >= MAX_ATTEMPTS) {
    const remainingTime = Math.ceil(
      (WINDOW_MS - (now - attempt.firstAttempt)) / 1000 / 60
    );
    return res.status(429).json({
      message: `Too many registration attempts. Please try again in ${remainingTime} minute(s).`,
    });
  }

  // Increment attempt count
  attempt.count++;
  attempt.lastAttempt = now;
  await setRateLimitToRedis(
    "signup",
    key,
    attempt,
    Math.ceil(WINDOW_MS / 1000)
  );

  next();
};

// Rate limiter for WhatsApp QR generation
export const qrRateLimit = async (req, res, next) => {
  // Use IP address + tenant as key
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const tenantSlug = req.tenant?.slug || "unknown";
  const key = `${ip}:${tenantSlug}`;

  const now = Date.now();
  const MAX_ATTEMPTS = 10;
  const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

  // Use Redis for distributed rate limiting
  let attempt = await getRateLimitFromRedis("qr", key);

  if (!attempt) {
    const newAttempt = { count: 1, firstAttempt: now, lastAttempt: now };
    await setRateLimitToRedis("qr", key, newAttempt, Math.ceil(WINDOW_MS / 1000));
    return next();
  }

  // Reset if window expired
  if (now - attempt.firstAttempt > WINDOW_MS) {
    const newAttempt = { count: 1, firstAttempt: now, lastAttempt: now };
    await setRateLimitToRedis("qr", key, newAttempt, Math.ceil(WINDOW_MS / 1000));
    return next();
  }

  // Check if exceeded limit
  if (attempt.count >= MAX_ATTEMPTS) {
    const remainingTime = Math.ceil((WINDOW_MS - (now - attempt.firstAttempt)) / 1000 / 60);
    return res.status(429).json({
      message: `Too many QR requests. Please try again in ${remainingTime} minute(s).`,
    });
  }

  // Increment attempt count
  attempt.count++;
  attempt.lastAttempt = now;
  await setRateLimitToRedis("qr", key, attempt, Math.ceil(WINDOW_MS / 1000));

  next();
};
