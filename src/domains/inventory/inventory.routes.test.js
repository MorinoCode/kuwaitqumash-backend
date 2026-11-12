import test from "node:test";
import assert from "node:assert/strict";
import router from "./inventory.routes.js";

const routes = [
  ["get", "/"],
  ["get", "/custom-options"],
  ["post", "/custom-options"],
  ["post", "/"],
  ["get", "/barcode/:barcode"],
  ["get", "/:id"],
  ["get", "/:id/check-deletable"],
  ["put", "/:id"],
  ["post", "/:id/delete-image"],
  ["post", "/:id/dismiss-alert"],
  ["delete", "/:id"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("inventory router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("inventory router mounts the expected middleware chain", () => {
  assert.equal(
    router.stack.filter((layer) => !layer.route).length >= 2,
    true,
    "tenant and auth middlewares must guard the router",
  );
});

test("inventory router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});
