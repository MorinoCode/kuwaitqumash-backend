import test from "node:test";
import assert from "node:assert/strict";
import router from "./customer.routes.js";

const routes = [
  ["get", "/"],
  ["get", "/:id"],
  ["get", "/:id/history"],
  ["get", "/:id/analytics"],
  ["post", "/"],
  ["put", "/:id"],
  ["delete", "/:id"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("customer router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("customer router mounts the expected middleware chain", () => {
  assert.equal(
    router.stack.filter((layer) => !layer.route).length >= 2,
    true,
    "tenant and auth middlewares must guard the router",
  );
});

test("customer router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});
