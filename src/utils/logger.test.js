import test from "node:test";
import assert from "node:assert/strict";
import logger from "./logger.js";

const capture = (method) => {
  const chunks = [];
  const original = process[method].write;
  process[method].write = (chunk) => {
    chunks.push(String(chunk));
    return true;
  };
  return {
    restore: () => {
      process[method].write = original;
    },
    output: () => chunks.join(""),
  };
};

test("info writes a JSON line to stdout", () => {
  const spy = capture("stdout");
  logger.info("Sale created", { component: "sales" });
  spy.restore();
  const entry = JSON.parse(spy.output().trim());
  assert.equal(entry.level, "info");
  assert.equal(entry.message, "Sale created");
  assert.equal(entry.component, "sales");
  assert.ok(entry.timestamp);
});

test("error writes to stderr", () => {
  const spy = capture("stderr");
  logger.error("Boom", { requestId: "abc" });
  spy.restore();
  const entry = JSON.parse(spy.output().trim());
  assert.equal(entry.level, "error");
  assert.equal(entry.requestId, "abc");
});

test("debug output is suppressed at the default level", () => {
  const spy = capture("stdout");
  logger.debug("hidden");
  spy.restore();
  assert.equal(spy.output(), "");
});
