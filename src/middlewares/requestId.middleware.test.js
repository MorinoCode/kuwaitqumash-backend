import test from "node:test";
import assert from "node:assert/strict";
import { requestId } from "./requestId.middleware.js";

const run = (headers = {}) => {
  const res = {
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
  const req = { headers };
  let nextCalled = false;
  requestId(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
};

test("keeps an incoming request id and echoes it back", () => {
  const { req, res, nextCalled } = run({ "x-request-id": "req-123" });
  assert.equal(req.requestId, "req-123");
  assert.equal(res.headers["x-request-id"], "req-123");
  assert.equal(nextCalled, true);
});

test("generates a uuid when the header is missing", () => {
  const { req, res } = run();
  assert.match(req.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(res.headers["x-request-id"], req.requestId);
});

test("ignores a blank incoming header", () => {
  const { req } = run({ "x-request-id": "   " });
  assert.match(req.requestId, /^[0-9a-f-]{36}$/);
});
