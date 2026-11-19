import test from "node:test";
import assert from "node:assert/strict";
import { invalidateDashboardCache } from "../../utils/dashboard-cache.js";
import { isRedisAvailable, ensureRedisConnected } from "../../config/redis.js";
import "../associations.js";
import Invoice from "../sales/invoice.model.js";

test("redis config: isRedisAvailable and ensureRedisConnected handle unconfigured state gracefully", async () => {
  // In test environment without REDIS_ENABLED=true
  assert.equal(typeof isRedisAvailable(), "boolean");
  const connected = await ensureRedisConnected(50);
  assert.equal(typeof connected, "boolean");
});

test("dashboard-cache: invalidateDashboardCache executes without errors", async () => {
  // Should not throw even if Redis is unavailable (falls back to memory cache)
  await assert.doesNotReject(async () => {
    await invalidateDashboardCache("test-store");
  });
});

test("associations: associations are loaded and eager loading can resolve includes", () => {
  // Invoice should have association definitions for worker queries
  assert.ok(Invoice.associations.items, "Invoice must associate items for worker include queries");
  assert.ok(Invoice.associations.branch, "Invoice must associate branch for worker queries");
  assert.ok(Invoice.associations.creator, "Invoice must associate creator for worker queries");
});

