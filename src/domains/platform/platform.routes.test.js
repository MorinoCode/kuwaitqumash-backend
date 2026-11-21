import test from "node:test";
import assert from "node:assert/strict";
import router from "./platform.routes.js";
import * as platformController from "./platform.controller.js";
import { buildTenantIdentifiers } from "./tenantProvisioning.service.js";

const routes = [
  ["post", "/register"],
  ["post", "/contact"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("platform router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("platform router mounts the expected middleware chain", () => {
  assert.ok(router.stack.some((layer) => layer.route));
});

test("platform router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});

test("buildTenantIdentifiers normalizes valid store names and rejects non-ASCII/dash-only names", () => {
  assert.deepEqual(buildTenantIdentifiers("  Al  Baraka Fabrics  "), {
    normalizedName: "al  baraka fabrics",
    slug: "al-baraka-fabrics",
    db_schema: "tenant_al_baraka_fabrics",
  });
  assert.throws(() => buildTenantIdentifiers("---"), { statusCode: 400 });
  assert.throws(() => buildTenantIdentifiers("پارچه سرای کویت"), { statusCode: 400 });
});

test("registerStore permanently blocks public self-registration with 403 regardless of env", async () => {
  const previous = process.env.ALLOW_PUBLIC_SIGNUP;
  process.env.ALLOW_PUBLIC_SIGNUP = "true";
  let statusCode = null;
  let payload = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(body) {
      payload = body;
      return this;
    },
  };
  try {
    await platformController.registerStore({ body: {} }, res);
    assert.equal(statusCode, 403);
    assert.equal(payload?.success, false);
  } finally {
    if (previous === undefined) delete process.env.ALLOW_PUBLIC_SIGNUP;
    else process.env.ALLOW_PUBLIC_SIGNUP = previous;
  }
});
