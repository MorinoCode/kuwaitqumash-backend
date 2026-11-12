import test from "node:test";
import assert from "node:assert/strict";
import { asyncHandler } from "./asyncHandler.middleware.js";

test("passes a resolved handler result through", async () => {
  const handler = asyncHandler(async (req, res) => {
    res.body = "ok";
  });
  const res = {};
  await handler({}, res, () => {});
  assert.equal(res.body, "ok");
});

test("forwards a rejected promise to next", async () => {
  const error = new Error("boom");
  const handler = asyncHandler(async () => {
    throw error;
  });
  const nextError = await new Promise((resolve) => {
    handler({}, {}, resolve);
  });
  assert.equal(nextError, error);
});

test("forwards synchronous throws to next", async () => {
  const handler = asyncHandler(() => {
    throw new Error("sync");
  });
  const nextError = await new Promise((resolve) => {
    handler({}, {}, resolve);
  });
  assert.equal(nextError.message, "sync");
});
