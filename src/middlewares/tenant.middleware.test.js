import test from "node:test";
import assert from "node:assert/strict";
import Tenant from "../domains/platform/tenant.model.js";
import { evaluateSubscriptionState, resolveTenant } from "./tenant.middleware.js";

const DAY_MS = 24 * 60 * 60 * 1000;

const makeRes = () => {
  const headers = {};
  return {
    statusCode: 200,
    body: null,
    headers,
    setHeader(k, v) {
      headers[k.toLowerCase()] = v;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
};

const withTenantFindOne = (t, impl) => {
  const original = Tenant.findOne;
  Tenant.findOne = impl;
  t.after(() => {
    Tenant.findOne = original;
  });
};

test("evaluateSubscriptionState marks expired within 7 days as grace period", () => {
  const now = Date.now();
  const state = evaluateSubscriptionState(
    {
      subscription_status: "active",
      subscription_expires_at: new Date(now - 2 * DAY_MS).toISOString(),
    },
    now,
  );
  assert.equal(state.allowed, true);
  assert.equal(state.mode, "grace");
  assert.equal(state.headers["x-subscription-warning"], "grace_period");
});

test("evaluateSubscriptionState marks expired past 7 days as readonly", () => {
  const now = Date.now();
  const state = evaluateSubscriptionState(
    {
      subscription_status: "active",
      subscription_expires_at: new Date(now - 10 * DAY_MS).toISOString(),
    },
    now,
  );
  assert.equal(state.allowed, true);
  assert.equal(state.mode, "readonly");
  assert.equal(state.headers["x-subscription-readonly"], "true");
});

test("resolveTenant blocks requests missing x-tenant-id", async () => {
  const res = makeRes();
  await resolveTenant({ headers: {}, method: "GET" }, res, () => {});
  assert.equal(res.statusCode, 400);
});

test("resolveTenant returns 403 for inactive tenant", async (t) => {
  withTenantFindOne(t, async () => ({
    id: 1,
    slug: "inactive-shop",
    db_schema: "tenant_inactive_shop",
    subscription_status: "suspended",
  }));

  const res = makeRes();
  let nextCalled = false;
  await resolveTenant(
    { headers: { "x-tenant-id": "inactive-shop" }, method: "GET" },
    res,
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.code, "SUBSCRIPTION_INACTIVE");
});

test("resolveTenant blocks POST in expired read-only mode but allows GET and auth login", async (t) => {
  const expiredDate = new Date(Date.now() - 12 * DAY_MS).toISOString();
  withTenantFindOne(t, async () => ({
    id: 2,
    slug: "expired-shop",
    db_schema: "tenant_expired_shop",
    subscription_status: "active",
    subscription_expires_at: expiredDate,
  }));

  const postRes = makeRes();
  let postNext = false;
  await resolveTenant(
    {
      headers: { "x-tenant-id": "expired-shop" },
      method: "POST",
      originalUrl: "/api/sales/create",
    },
    postRes,
    () => {
      postNext = true;
    },
  );
  assert.equal(postNext, false);
  assert.equal(postRes.statusCode, 403);
  assert.equal(postRes.body.code, "SUBSCRIPTION_EXPIRED_READONLY");

  const getRes = makeRes();
  let getNext = false;
  await resolveTenant(
    {
      headers: { "x-tenant-id": "expired-shop" },
      method: "GET",
      originalUrl: "/api/sales/invoices",
    },
    getRes,
    () => {
      getNext = true;
    },
  );
  assert.equal(getNext, true);
  assert.equal(getRes.headers["x-subscription-readonly"], "true");

  const loginRes = makeRes();
  let loginNext = false;
  await resolveTenant(
    {
      headers: { "x-tenant-id": "expired-shop" },
      method: "POST",
      originalUrl: "/api/auth/login",
    },
    loginRes,
    () => {
      loginNext = true;
    },
  );
  assert.equal(loginNext, true);
});

