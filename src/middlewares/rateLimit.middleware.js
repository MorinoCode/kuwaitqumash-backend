import {
  cacheGet,
  cacheSet,
  getRedisClient,
} from "../config/redis.js";
import logger from "../utils/logger.js";

const REDIS_RATE_LIMIT_PREFIX = "rate_limit:";
const REDIS_RATE_LIMIT_SET = "rate_limit:keys";

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

export const loginRateLimit = async (req, res, next) => {

  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const username = req.body?.username || "unknown";
  const key = `${ip}:${username}`;

  const now = Date.now();
  const MAX_ATTEMPTS = 5;
  const WINDOW_MS = 15 * 60 * 1000;

  let attempt = await getRateLimitFromRedis("login", key);

  if (!attempt) {

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

  if (attempt.count >= MAX_ATTEMPTS) {
    const remainingTime = Math.ceil(
      (WINDOW_MS - (now - attempt.firstAttempt)) / 1000 / 60
    );
    return res.status(429).json({
      message: `Too many login attempts. Please try again in ${remainingTime} minute(s).`,
    });
  }

  attempt.count++;
  attempt.lastAttempt = now;
  await setRateLimitToRedis("login", key, attempt, Math.ceil(WINDOW_MS / 1000));

  next();
};

export const signupRateLimit = async (req, res, next) => {

  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const key = ip;

  const now = Date.now();
  const isProduction = process.env.NODE_ENV === "production";
  const MAX_ATTEMPTS = isProduction ? 3 : 30;
  const WINDOW_MS = isProduction ? 60 * 60 * 1000 : 15 * 60 * 1000;

  let attempt = await getRateLimitFromRedis("signup", key);

  if (!attempt) {

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

  if (attempt.count >= MAX_ATTEMPTS) {
    const remainingTime = Math.ceil(
      (WINDOW_MS - (now - attempt.firstAttempt)) / 1000 / 60
    );
    return res.status(429).json({
      message: `Too many registration attempts. Please try again in ${remainingTime} minute(s).`,
    });
  }

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

export const qrRateLimit = async (req, res, next) => {

  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const tenantSlug = req.tenant?.slug || "unknown";
  const key = `${ip}:${tenantSlug}`;

  const now = Date.now();
  const MAX_ATTEMPTS = 10;
  const WINDOW_MS = 5 * 60 * 1000;

  let attempt = await getRateLimitFromRedis("qr", key);

  if (!attempt) {
    const newAttempt = { count: 1, firstAttempt: now, lastAttempt: now };
    await setRateLimitToRedis("qr", key, newAttempt, Math.ceil(WINDOW_MS / 1000));
    return next();
  }

  if (now - attempt.firstAttempt > WINDOW_MS) {
    const newAttempt = { count: 1, firstAttempt: now, lastAttempt: now };
    await setRateLimitToRedis("qr", key, newAttempt, Math.ceil(WINDOW_MS / 1000));
    return next();
  }

  if (attempt.count >= MAX_ATTEMPTS) {
    const remainingTime = Math.ceil((WINDOW_MS - (now - attempt.firstAttempt)) / 1000 / 60);
    return res.status(429).json({
      message: `Too many QR requests. Please try again in ${remainingTime} minute(s).`,
    });
  }

  attempt.count++;
  attempt.lastAttempt = now;
  await setRateLimitToRedis("qr", key, attempt, Math.ceil(WINDOW_MS / 1000));

  next();
};
