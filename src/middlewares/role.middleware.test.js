import test from "node:test";
import assert from "node:assert/strict";
import { restrictTo } from "./role.middleware.js";

const run = (middleware, user) => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  let nextCalled = false;
  middleware({ user }, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
};

test("lets an allowed role through", () => {
  const { nextCalled } = run(restrictTo("store_owner"), { role: "store_owner" });
  assert.equal(nextCalled, true);
});

test("blocks a role that is not allowed with 403", () => {
  const { res, nextCalled } = run(restrictTo("store_owner"), { role: "salesman" });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.match(res.body.message, /Access denied/);
});

test("accepts any of several allowed roles", () => {
  const { nextCalled } = run(restrictTo("store_owner", "branch_manager"), {
    role: "branch_manager",
  });
  assert.equal(nextCalled, true);
});
