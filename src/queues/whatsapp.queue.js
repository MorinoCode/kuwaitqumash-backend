import crypto from "node:crypto";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { getRedisClient, isRedisEnabled } from "../config/redis.js";
import logger from "../utils/logger.js";

export const WA_TRANSACTIONAL_QUEUE = "wa-transactional";
export const WA_BULK_QUEUE = "wa-bulk";
export const WA_CMD_CHANNEL = "wa:cmd";
export const getWaEventChannel = (sessionKey) => `wa:evt:${sessionKey}`;
export const getWaStatusCacheKey = (sessionKey) => `wa:status:${sessionKey}`;
export const getWaPairedAtCacheKey = (sessionKey) => `wa:paired_at:${sessionKey}`;
export const getWaBulkNextSlotKey = (tenantSlug) => `wa:bulk:next_slot:${tenantSlug}`;

const KUWAIT_UTC_OFFSET_MS = 3 * 60 * 60 * 1000;

export const getBulkDailyLimit = () =>
  Math.max(1, Number.parseInt(process.env.WA_BULK_DAILY_LIMIT || "100", 10) || 100);

export const getWarmupDailyLimit = () =>
  Math.max(1, Number.parseInt(process.env.WA_WARMUP_DAILY_LIMIT || "20", 10) || 20);

export const getWarmupHours = () =>
  Math.max(0, Number.parseInt(process.env.WA_WARMUP_HOURS || "24", 10) || 24);

export const getQuietHoursBounds = () => ({
  startHour: Math.max(
    0,
    Math.min(23, Number.parseInt(process.env.WA_QUIET_START_HOUR || "9", 10) || 9),
  ),
  endHour: Math.max(
    1,
    Math.min(24, Number.parseInt(process.env.WA_QUIET_END_HOUR || "22", 10) || 22),
  ),
});

export const getSessionKey = (tenantSlug, branchId = null) =>
  branchId ? `${tenantSlug}_branch_${branchId}` : tenantSlug;

/**
 * Formats YYYY-MM-DD in Asia/Kuwait timezone (permanent UTC+3, no DST).
 */
export const getKuwaitDateString = (nowMs = Date.now()) => {
  const kuwait = new Date(nowMs + KUWAIT_UTC_OFFSET_MS);
  return kuwait.toISOString().slice(0, 10);
};

export const getKuwaitHour = (timestampMs = Date.now()) => {
  const kuwait = new Date(timestampMs + KUWAIT_UTC_OFFSET_MS);
  return kuwait.getUTCHours();
};

export const getBulkQuotaKey = (tenantSlug, nowMs = Date.now()) =>
  `wa:bulk:${tenantSlug}:${getKuwaitDateString(nowMs)}`;

/**
 * Shifts a target UTC timestamp forward into allowed Kuwait hours [startHour, endHour).
 * Kuwait uses UTC+3 year-round without DST.
 */
export const snapToKuwaitAllowedWindow = (
  targetMs,
  { startHour = 9, endHour = 22 } = getQuietHoursBounds(),
  jitterSeconds = 0,
) => {
  const shiftedMs = targetMs + KUWAIT_UTC_OFFSET_MS;
  const k = new Date(shiftedMs);
  const hour = k.getUTCHours();

  if (hour >= startHour && hour < endHour) {
    return targetMs;
  }

  const candidateKuwait = new Date(
    Date.UTC(
      k.getUTCFullYear(),
      k.getUTCMonth(),
      hour >= endHour ? k.getUTCDate() + 1 : k.getUTCDate(),
      startHour,
      0,
      jitterSeconds,
      0,
    ),
  );

  return candidateKuwait.getTime() - KUWAIT_UTC_OFFSET_MS;
};

/**
 * Computes human-like bulk pacing offsets:
 * - 20-45s randomized delay between consecutive messages
 * - additional 3-5 minute pause after every 20 messages
 * - snaps each timestamp inside Kuwait permitted hours (09:00-22:00 Asia/Kuwait)
 */
export const computeBulkScheduleOffsets = (
  count,
  startTimeMs = Date.now(),
  randomFn = Math.random,
  quietBounds = getQuietHoursBounds(),
) => {
  const delaysMs = [];
  let cursorMs = snapToKuwaitAllowedWindow(startTimeMs, quietBounds);

  for (let i = 0; i < count; i++) {
    if (i > 0) {
      const msgGapMs = (20 + Math.floor(randomFn() * 26)) * 1000; // 20s..45s
      cursorMs += msgGapMs;
      if (i % 20 === 0) {
        const batchPauseMs = (180 + Math.floor(randomFn() * 121)) * 1000; // 3m..5m
        cursorMs += batchPauseMs;
      }
      cursorMs = snapToKuwaitAllowedWindow(cursorMs, quietBounds);
    }
    delaysMs.push(Math.max(0, cursorMs - Date.now()));
  }

  return {
    delaysMs,
    lastScheduledAtMs: cursorMs,
  };
};

let bullConnection = null;
let transactionalQueue = null;
let bulkQueue = null;

export const createBullRedisConnection = () => {
  if (!isRedisEnabled()) return null;
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  return new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 250, 5000),
  });
};

const getSharedQueueConnection = () => {
  if (!isRedisEnabled()) return null;
  if (!bullConnection) {
    bullConnection = createBullRedisConnection();
    bullConnection.on("error", (err) => {
      logger.warn("BullMQ Redis connection error", {
        component: "whatsapp.queue",
        error: err?.message,
      });
    });
  }
  return bullConnection;
};

export const getTransactionalQueue = () => {
  const connection = getSharedQueueConnection();
  if (!connection) return null;
  if (!transactionalQueue) {
    transactionalQueue = new Queue(WA_TRANSACTIONAL_QUEUE, {
      connection,
      defaultJobOptions: {
        priority: 1,
        attempts: 3,
        backoff: { type: "exponential", delay: 5000 },
        removeOnComplete: { age: 86400, count: 500 },
        removeOnFail: { age: 7 * 86400, count: 500 },
      },
    });
  }
  return transactionalQueue;
};

export const getBulkQueue = () => {
  const connection = getSharedQueueConnection();
  if (!connection) return null;
  if (!bulkQueue) {
    bulkQueue = new Queue(WA_BULK_QUEUE, {
      connection,
      defaultJobOptions: {
        priority: 10,
        attempts: 2,
        backoff: { type: "fixed", delay: 30000 },
        removeOnComplete: { age: 86400, count: 1000 },
        removeOnFail: { age: 7 * 86400, count: 1000 },
      },
    });
  }
  return bulkQueue;
};

export const closeWhatsAppQueues = async () => {
  const tasks = [];
  if (transactionalQueue) {
    tasks.push(transactionalQueue.close().catch(() => {}));
    transactionalQueue = null;
  }
  if (bulkQueue) {
    tasks.push(bulkQueue.close().catch(() => {}));
    bulkQueue = null;
  }
  if (bullConnection) {
    tasks.push(bullConnection.quit().catch(() => {}));
    bullConnection = null;
  }
  await Promise.all(tasks);
};

export const enqueueTransactionalDocument = async ({
  tenantSlug,
  phone,
  pdfBuffer,
  fileName,
  caption,
  branchId = null,
  invoiceNumber = null,
}) => {
  const queue = getTransactionalQueue();
  if (!queue) return null;

  const buffer = Buffer.isBuffer(pdfBuffer) ? pdfBuffer : Buffer.from(pdfBuffer);
  const job = await queue.add("send-invoice-pdf", {
    tenantSlug,
    phone,
    pdfBase64: buffer.toString("base64"),
    fileName,
    caption,
    branchId,
    invoiceNumber,
  });

  return job.id;
};

const RESERVE_QUOTA_LUA = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local current = tonumber(redis.call("GET", key) or "0")
if current + amount > limit then
  return {0, current}
end
local nextVal = redis.call("INCRBY", key, amount)
if redis.call("TTL", key) < 0 then
  redis.call("EXPIRE", key, ttl)
end
return {1, nextVal}
`;

export const getWaBulkLockKey = (tenantSlug) => `wa:bulk:lock:${tenantSlug}`;

const memoryDailyCounts = new Map();
const inMemoryLocks = new Map();

export const acquireBulkSlotLock = async (
  tenantSlug,
  ttlMs = 10000,
  maxWaitMs = 12000,
) => {
  const client = getRedisClient();
  const lockKey = getWaBulkLockKey(tenantSlug);
  const token = crypto.randomUUID();
  const startTime = Date.now();

  if (!client) {
    while (inMemoryLocks.has(lockKey)) {
      if (Date.now() - startTime > maxWaitMs) {
        throw new Error("Timeout acquiring WhatsApp bulk scheduling lock");
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    inMemoryLocks.set(lockKey, token);
    return token;
  }

  while (Date.now() - startTime < maxWaitMs) {
    const res = await client.set(lockKey, token, "PX", ttlMs, "NX");
    if (res === "OK") return token;
    await new Promise((r) => setTimeout(r, 60));
  }

  throw new Error("Timeout acquiring WhatsApp bulk scheduling lock");
};

export const releaseBulkSlotLock = async (tenantSlug, token) => {
  const client = getRedisClient();
  const lockKey = getWaBulkLockKey(tenantSlug);

  if (!client) {
    if (inMemoryLocks.get(lockKey) === token) {
      inMemoryLocks.delete(lockKey);
    }
    return;
  }

  const RELEASE_LOCK_LUA = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  try {
    await client.eval(RELEASE_LOCK_LUA, 1, lockKey, token);
  } catch (err) {
    logger.debug("Failed to release bulk slot lock", {
      component: "whatsapp.queue",
      lockKey,
      error: err?.message,
    });
  }
};

export const getEffectiveBulkLimitForSession = async (sessionKey, nowMs = Date.now()) => {
  const dailyLimit = getBulkDailyLimit();
  const warmupHours = getWarmupHours();
  if (warmupHours <= 0) {
    return { limit: dailyLimit, isWarmup: false };
  }

  const client = getRedisClient();
  let pairedAtRaw = null;
  if (client) {
    pairedAtRaw = await client.get(getWaPairedAtCacheKey(sessionKey));
    if (!pairedAtRaw && sessionKey.includes("_branch_")) {
      const tenantSlug = sessionKey.split("_branch_")[0];
      pairedAtRaw = await client.get(getWaPairedAtCacheKey(tenantSlug));
    }
  }

  if (!pairedAtRaw) {
    return { limit: dailyLimit, isWarmup: false };
  }

  const pairedAtMs = Number(pairedAtRaw);
  const warmupWindowMs = warmupHours * 60 * 60 * 1000;
  if (!Number.isNaN(pairedAtMs) && nowMs - pairedAtMs < warmupWindowMs) {
    return {
      limit: Math.min(dailyLimit, getWarmupDailyLimit()),
      isWarmup: true,
      warmupEndsAt: new Date(pairedAtMs + warmupWindowMs).toISOString(),
    };
  }

  return { limit: dailyLimit, isWarmup: false };
};

export const reserveDailyBulkQuota = async (
  tenantSlug,
  requestedCount,
  dailyLimit,
  nowMs = Date.now(),
) => {
  const key = getBulkQuotaKey(tenantSlug, nowMs);
  const client = getRedisClient();

  if (!client) {
    const current = memoryDailyCounts.get(key) || 0;
    if (current + requestedCount > dailyLimit) {
      return {
        allowed: false,
        used: current,
        remaining: Math.max(0, dailyLimit - current),
        limit: dailyLimit,
        key,
      };
    }
    const nextVal = current + requestedCount;
    memoryDailyCounts.set(key, nextVal);
    return {
      allowed: true,
      used: nextVal,
      remaining: Math.max(0, dailyLimit - nextVal),
      limit: dailyLimit,
      key,
    };
  }

  const [allowedFlag, countValue] = await client.eval(
    RESERVE_QUOTA_LUA,
    1,
    key,
    String(requestedCount),
    String(dailyLimit),
    String(48 * 60 * 60),
  );

  const used = Number(countValue || 0);
  if (Number(allowedFlag) !== 1) {
    return {
      allowed: false,
      used,
      remaining: Math.max(0, dailyLimit - used),
      limit: dailyLimit,
      key,
    };
  }

  return {
    allowed: true,
    used,
    remaining: Math.max(0, dailyLimit - used),
    limit: dailyLimit,
    key,
  };
};

export const releaseDailyBulkQuota = async (
  tenantSlug,
  amount,
  nowMs = Date.now(),
) => {
  const key = getBulkQuotaKey(tenantSlug, nowMs);
  const client = getRedisClient();
  if (!client) {
    const prev = memoryDailyCounts.get(key) || 0;
    memoryDailyCounts.set(key, Math.max(0, prev - amount));
    return;
  }
  const nextVal = await client.decrby(key, amount);
  if (nextVal <= 0) {
    await client.del(key);
  }
};

export const enqueueBulkMessages = async ({
  tenantSlug,
  branchId = null,
  recipients,
  message,
}) => {
  const queue = getBulkQueue();
  if (!queue) {
    throw new Error("Redis is required to queue bulk WhatsApp messages.");
  }

  const sessionKey = getSessionKey(tenantSlug, branchId);
  const { limit, isWarmup, warmupEndsAt } =
    await getEffectiveBulkLimitForSession(sessionKey);

  const lockToken = await acquireBulkSlotLock(tenantSlug);
  let firstScheduledMs = Date.now();
  let quota = null;

  try {
    const redis = getRedisClient();
    const slotKey = getWaBulkNextSlotKey(tenantSlug);
    const existingCursor = redis ? Number((await redis.get(slotKey)) || 0) : 0;
    const startAtMs = Math.max(Date.now(), existingCursor + 25000);
    const quietBounds = getQuietHoursBounds();

    firstScheduledMs = snapToKuwaitAllowedWindow(startAtMs, quietBounds);

    quota = await reserveDailyBulkQuota(
      tenantSlug,
      recipients.length,
      limit,
      firstScheduledMs,
    );

    if (!quota.allowed) {
      const error = new Error(
        `Daily WhatsApp bulk limit reached (${quota.used}/${quota.limit}). Remaining today: ${quota.remaining}.`,
      );
      error.statusCode = 429;
      error.details = {
        ...quota,
        isWarmup,
        warmupEndsAt,
        requested: recipients.length,
      };
      throw error;
    }

    const { delaysMs, lastScheduledAtMs } = computeBulkScheduleOffsets(
      recipients.length,
      startAtMs,
    );
    const batchId = crypto.randomUUID();

    const jobs = recipients.map((phone, index) => ({
      name: "send-bulk-text",
      data: {
        batchId,
        tenantSlug,
        branchId,
        phone,
        message,
        sequence: index + 1,
        total: recipients.length,
      },
      opts: {
        delay: delaysMs[index],
        jobId: `bulk-${tenantSlug}-${batchId}-${index}`,
      },
    }));

    await queue.addBulk(jobs);
    if (redis) {
      const cursorTtlSec = Math.max(
        300,
        Math.ceil((lastScheduledAtMs - Date.now()) / 1000) + 300,
      );
      await redis.set(slotKey, String(lastScheduledAtMs), "EX", cursorTtlSec);
    }

    const estimatedMinutes = Math.max(
      1,
      Math.ceil((lastScheduledAtMs - Date.now()) / 60000),
    );

    return {
      batchId,
      queued: recipients.length,
      limit: quota.limit,
      used: quota.used,
      remaining: quota.remaining,
      isWarmup,
      warmupEndsAt,
      estimatedMinutes,
    };
  } catch (err) {
    if (quota && quota.allowed) {
      await releaseDailyBulkQuota(
        tenantSlug,
        recipients.length,
        firstScheduledMs,
      );
    }
    throw err;
  } finally {
    await releaseBulkSlotLock(tenantSlug, lockToken);
  }
};

