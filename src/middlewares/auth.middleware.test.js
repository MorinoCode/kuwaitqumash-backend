import test from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import User from "../domains/auth/user.model.js";
import { protect, restrictTo, invalidateAuthUserCache } from "./auth.middleware.js";

process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";

const tenant = { slug: "kuwait-qumash", db_schema: "tenant_test" };

const makeRes = () => {
  const res = {
    statusCode: null,
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
  return res;
};

const tokenFor = (payload = {}) =>
  jwt.sign({ id: 1, tenant: tenant.slug, ...payload }, process.env.JWT_SECRET);

// The model hits PostgreSQL for real, so both helpers are replaced with stubs.
const withUserLookup = async (t, implementation) => {
  const originalSchema = User.schema;
  User.schema = () => ({ findByPk: implementation });
  t.after(() => {
    User.schema = originalSchema;
  });
};

test("protect rejects a request without tenant context", async () => {
  const res = makeRes();
  let called = false;
  await protect({ headers: {}, cookies: {} }, res, () => {
    called = true;
  });
  assert.equal(res.statusCode, 500);
  assert.equal(called, false);
});

test("protect rejects a request without a token", async () => {
  const res = makeRes();
  await protect({ tenant, headers: {}, cookies: {} }, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /no token/i);
});

test("protect reads the token from the cookie", async (t) => {
  await withUserLookup(t, async () => ({ id: 1, is_active: true, role: "store_owner" }));
  const req = { tenant, headers: {}, cookies: { token: tokenFor() } };
  const res = makeRes();
  let nextCalled = false;
  await protect(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.equal(req.user.id, 1);
});

test("protect reads the bearer token and excludes the password", async (t) => {
  let receivedOptions = null;
  await withUserLookup(t, async (_id, options) => {
    receivedOptions = options;
    return { id: 1, is_active: true };
  });
  const req = {
    tenant,
    headers: { authorization: `Bearer ${tokenFor()}` },
    cookies: {},
  };
  const res = makeRes();
  let nextCalled = false;
  await protect(req, res, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
  assert.deepEqual(receivedOptions.attributes, { exclude: ["password"] });
});

test("protect rejects a token issued for another store", async (t) => {
  await withUserLookup(t, async () => ({ id: 1, is_active: true }));
  const req = {
    tenant,
    headers: { authorization: `Bearer ${tokenFor({ tenant: "other-store" })}` },
    cookies: {},
  };
  const res = makeRes();
  await protect(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /this store/i);
});

test("protect rejects a deleted user", async (t) => {
  await withUserLookup(t, async () => null);
  const req = {
    tenant,
    headers: { authorization: `Bearer ${tokenFor()}` },
    cookies: {},
  };
  const res = makeRes();
  await protect(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /not found/i);
});

test("protect rejects an inactive account", async (t) => {
  await withUserLookup(t, async () => ({ id: 1, is_active: false }));
  const req = {
    tenant,
    headers: { authorization: `Bearer ${tokenFor()}` },
    cookies: {},
  };
  const res = makeRes();
  await protect(req, res, () => {});
  assert.equal(res.statusCode, 403);
});

test("protect rejects a token whose token_version is stale", async (t) => {
  await withUserLookup(t, async () => ({ id: 1, is_active: true, token_version: 2 }));
  const req = {
    tenant,
    headers: { authorization: `Bearer ${tokenFor({ tv: 1 })}` },
    cookies: {},
  };
  const res = makeRes();
  await protect(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /revoked|expired/i);
});

test("protect rejects a malformed token", async () => {
  const req = {
    tenant,
    headers: { authorization: "Bearer not-a-jwt" },
    cookies: {},
  };
  const res = makeRes();
  await protect(req, res, () => {});
  assert.equal(res.statusCode, 401);
  assert.match(res.body.message, /token failed/i);
});

test("restrictTo allows a listed role", () => {
  let nextCalled = false;
  restrictTo("store_owner", "branch_manager")(
    { user: { role: "branch_manager" } },
    makeRes(),
    () => {
      nextCalled = true;
    },
  );
  assert.equal(nextCalled, true);
});

test("restrictTo blocks roles outside the list", () => {
  const res = makeRes();
  restrictTo("store_owner")({ user: { role: "sales_man" } }, res, () => {});
  assert.equal(res.statusCode, 403);
});

test("protect caches user lookups when TTL > 0 and respects invalidateAuthUserCache", async (t) => {
  const prevTtl = process.env.AUTH_USER_CACHE_TTL_SECONDS;
  process.env.AUTH_USER_CACHE_TTL_SECONDS = "30";
  t.after(async () => {
    if (prevTtl === undefined) delete process.env.AUTH_USER_CACHE_TTL_SECONDS;
    else process.env.AUTH_USER_CACHE_TTL_SECONDS = prevTtl;
    await invalidateAuthUserCache(tenant.db_schema, 999);
  });

  let dbHits = 0;
  await withUserLookup(t, async () => {
    dbHits += 1;
    return { id: 999, is_active: true, role: "sales_man", token_version: 0 };
  });

  const authHeader = `Bearer ${tokenFor({ id: 999 })}`;
  await protect({ tenant, headers: { authorization: authHeader }, cookies: {} }, makeRes(), () => {});
  await protect({ tenant, headers: { authorization: authHeader }, cookies: {} }, makeRes(), () => {});
  assert.equal(dbHits, 1, "second request should be served from auth user cache");

  await invalidateAuthUserCache(tenant.db_schema, 999);
  await protect({ tenant, headers: { authorization: authHeader }, cookies: {} }, makeRes(), () => {});
  assert.equal(dbHits, 2, "invalidating cache should trigger a fresh DB lookup");
});
