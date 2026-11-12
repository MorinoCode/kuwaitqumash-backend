import test from "node:test";
import assert from "node:assert/strict";
import router from "./refund.routes.js";

const routes = [
  ["get", "/invoices/:id/for-refund"],
  ["get", "/:id/pdf"],
  ["post", "/"],
  ["get", "/"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("refund router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("refund router mounts the expected middleware chain", () => {
  assert.equal(
    router.stack.filter((layer) => !layer.route).length >= 2,
    true,
    "tenant and auth middlewares must guard the router",
  );
});

test("refund router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});
