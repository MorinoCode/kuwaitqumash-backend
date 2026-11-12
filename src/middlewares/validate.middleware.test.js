import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { validate } from "./validate.middleware.js";

const runMiddleware = (middleware, req) => {
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
  middleware(req, res, () => {
    nextCalled = true;
  });
  return { req, res, nextCalled };
};

test("replaces the body with the parsed value and calls next", () => {
  const schema = z.object({ amount: z.coerce.number() }).strict();
  const { req, nextCalled } = runMiddleware(validate(schema), { body: { amount: "12" } });
  assert.equal(nextCalled, true);
  assert.equal(req.body.amount, 12);
});

test("responds with 400 and the first message when validation fails", () => {
  const schema = z.object({ amount: z.number() }).strict();
  const { res, nextCalled } = runMiddleware(validate(schema), { body: { amount: "x" } });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.success, false);
  assert.match(res.body.message, /^amount: /);
  assert.ok(Array.isArray(res.body.errors));
});

test("validates the requested source instead of the body", () => {
  const schema = z.object({ page: z.coerce.number().int() }).strict();
  const { req, nextCalled } = runMiddleware(validate(schema, "query"), {
    body: {},
    query: { page: "3" },
  });
  assert.equal(nextCalled, true);
  assert.equal(req.query.page, 3);
});
