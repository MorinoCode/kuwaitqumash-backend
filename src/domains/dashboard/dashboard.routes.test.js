import test from "node:test";
import assert from "node:assert/strict";
import router from "./dashboard.routes.js";

const routes = [
  ["get", "/owner"],
  ["get", "/manager"],
  ["get", "/salesman"],
  ["get", "/analytics"],
  ["get", "/top-items"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("dashboard router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("dashboard router mounts the expected middleware chain", () => {
  assert.equal(
    router.stack.filter((layer) => !layer.route).length >= 2,
    true,
    "tenant and auth middlewares must guard the router",
  );
});

test("dashboard router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});
