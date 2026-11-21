import test from "node:test";
import assert from "node:assert/strict";
import { RedisRateLimitStore } from "./redisRateLimitStore.js";

test("RedisRateLimitStore falls back cleanly to local memory when Redis is unavailable", async () => {
  const store = new RedisRateLimitStore({
    prefix: "test:rl:",
    getClient: () => null,
  });
  store.init({ windowMs: 1000 });

  const first = await store.increment("127.0.0.1");
  const second = await store.increment("127.0.0.1");
  assert.equal(first.totalHits, 1);
  assert.equal(second.totalHits, 2);
  assert.ok(second.resetTime instanceof Date);

  await store.decrement("127.0.0.1");
  const third = await store.increment("127.0.0.1");
  assert.equal(third.totalHits, 2);

  await store.resetKey("127.0.0.1");
  const afterReset = await store.increment("127.0.0.1");
  assert.equal(afterReset.totalHits, 1);

  store.shutdown();
});

test("RedisRateLimitStore uses Redis eval atomically when client is available", async () => {
  const counts = new Map();
  const fakeRedis = {
    async eval(_script, _numKeys, key, windowMs) {
      const next = (counts.get(key) || 0) + 1;
      counts.set(key, next);
      return [next, Number(windowMs)];
    },
    async decr(key) {
      counts.set(key, Math.max(0, (counts.get(key) || 0) - 1));
    },
    async del(key) {
      counts.delete(key);
    },
  };

  const store = new RedisRateLimitStore({
    prefix: "rl:api:",
    getClient: () => fakeRedis,
  });
  store.init({ windowMs: 60000 });

  const r1 = await store.increment("ip-1");
  const r2 = await store.increment("ip-1");
  assert.equal(r1.totalHits, 1);
  assert.equal(r2.totalHits, 2);
  assert.equal(counts.get("rl:api:ip-1"), 2);

  await store.resetKey("ip-1");
  assert.equal(counts.has("rl:api:ip-1"), false);
  store.shutdown();
});
