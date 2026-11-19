import test from "node:test";
import assert from "node:assert/strict";
import router from "./admin.routes.js";

const routes = [
  ["post", "/login"],
  ["post", "/logout"],
  ["get", "/me"],
  ["get", "/tenants"],
  ["post", "/tenants"],
  ["get", "/tenants/:id"],
  ["put", "/tenants/:id"],
  ["delete", "/tenants/:id"],
  ["get", "/tenants/:id/branches"],
  ["post", "/tenants/:id/branches"],
  ["put", "/tenants/:id/branches/:branchId"],
  ["delete", "/tenants/:id/branches/:branchId"],
  ["get", "/tenants/:id/inventory"],
  ["get", "/tenants/:id/invoices"],
  ["get", "/tenants/:id/customers"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) =>
      layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("admin router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("admin router mounts protectAdmin middleware before protected routes", () => {
  assert.ok(router.stack.some((layer) => !layer.route));
});

test("admin router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});

