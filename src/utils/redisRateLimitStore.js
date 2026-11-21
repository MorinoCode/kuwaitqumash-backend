import { getRedisClient } from "../config/redis.js";
import logger from "./logger.js";

const INCREMENT_LUA = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local pttl = redis.call('PTTL', KEYS[1])
if pttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  pttl = tonumber(ARGV[1])
end
return {current, pttl}
`;

const MAX_FALLBACK_KEYS = 20000;

/**
 * express-rate-limit v7 store backed by Redis when available, with automatic
 * graceful fallback to a bounded in-memory Map when Redis is disabled or down.
 */
export class RedisRateLimitStore {
  constructor({ prefix = "rl:api:", getClient = getRedisClient } = {}) {
    this.prefix = prefix;
    this.getClient = getClient;
    this.windowMs = 60_000;
    this.localHits = new Map();
    this.cleanupTimer = null;
  }

  init(options) {
    this.windowMs = Number(options?.windowMs) || 60_000;
    if (!this.cleanupTimer) {
      this.cleanupTimer = setInterval(
        () => this.pruneExpiredLocal(),
        Math.max(this.windowMs, 30_000),
      );
      if (typeof this.cleanupTimer.unref === "function") {
        this.cleanupTimer.unref();
      }
    }
  }

  pruneExpiredLocal(now = Date.now()) {
    for (const [key, entry] of this.localHits.entries()) {
      if (entry.resetMs <= now) {
        this.localHits.delete(key);
      }
    }
  }

  _incrementLocal(key) {
    const now = Date.now();
    const existing = this.localHits.get(key);
    if (!existing || existing.resetMs <= now) {
      if (this.localHits.size >= MAX_FALLBACK_KEYS) {
        this.pruneExpiredLocal(now);
        if (this.localHits.size >= MAX_FALLBACK_KEYS) {
          const oldestKey = this.localHits.keys().next().value;
          if (oldestKey !== undefined) this.localHits.delete(oldestKey);
        }
      }
      const resetMs = now + this.windowMs;
      this.localHits.set(key, { count: 1, resetMs });
      return { totalHits: 1, resetTime: new Date(resetMs) };
    }
    existing.count += 1;
    return { totalHits: existing.count, resetTime: new Date(existing.resetMs) };
  }

  async increment(key) {
    const fullKey = `${this.prefix}${key}`;
    const client = this.getClient();
    if (client) {
      try {
        const result = await client.eval(
          INCREMENT_LUA,
          1,
          fullKey,
          String(this.windowMs),
        );
        const totalHits = Number(result?.[0]) || 1;
        const pttl = Math.max(Number(result?.[1]) || this.windowMs, 1);
        return { totalHits, resetTime: new Date(Date.now() + pttl) };
      } catch (error) {
        logger.debug("Redis rate-limit increment failed; falling back to local memory", {
          component: "rate-limit",
          error: error?.message,
        });
      }
    }
    return this._incrementLocal(fullKey);
  }

  async decrement(key) {
    const fullKey = `${this.prefix}${key}`;
    const client = this.getClient();
    if (client) {
      try {
        await client.decr(fullKey);
        return;
      } catch (error) {
        logger.debug("Redis rate-limit decrement failed", {
          component: "rate-limit",
          error: error?.message,
        });
      }
    }
    const existing = this.localHits.get(fullKey);
    if (existing && existing.count > 0) {
      existing.count -= 1;
    }
  }

  async resetKey(key) {
    const fullKey = `${this.prefix}${key}`;
    this.localHits.delete(fullKey);
    const client = this.getClient();
    if (client) {
      try {
        await client.del(fullKey);
      } catch (error) {
        logger.debug("Redis rate-limit resetKey failed", {
          component: "rate-limit",
          error: error?.message,
        });
      }
    }
  }

  shutdown() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.localHits.clear();
  }
}

export default RedisRateLimitStore;
