import test from "node:test";
import assert from "node:assert/strict";
import {
  memoryCacheGet,
  memoryCacheSet,
  memoryCacheDelete,
  memoryCacheDeletePattern,
} from "./memory-cache.js";

test("returns the stored value before the TTL expires", () => {
  memoryCacheSet("unit:key", { value: 7 }, 60);
  assert.deepEqual(memoryCacheGet("unit:key"), { value: 7 });
});

test("returns null for a missing key", () => {
  assert.equal(memoryCacheGet("unit:missing"), null);
});

test("expires a value once the TTL has passed", () => {
  memoryCacheSet("unit:expired", "old", -1);
  assert.equal(memoryCacheGet("unit:expired"), null);
});

test("deletes a single key", () => {
  memoryCacheSet("unit:delete", 1, 60);
  memoryCacheDelete("unit:delete");
  assert.equal(memoryCacheGet("unit:delete"), null);
});

test("deletes every key matching a wildcard pattern", () => {
  memoryCacheSet("dashboard:owner:shop-a:1", 1, 60);
  memoryCacheSet("dashboard:owner:shop-b:1", 2, 60);
  memoryCacheDeletePattern("dashboard:*:shop-a:*");
  assert.equal(memoryCacheGet("dashboard:owner:shop-a:1"), null);
  assert.equal(memoryCacheGet("dashboard:owner:shop-b:1"), 2);
  memoryCacheDelete("dashboard:owner:shop-b:1");
});
