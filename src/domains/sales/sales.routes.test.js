import test from "node:test";
import assert from "node:assert/strict";
import router from "./sales.routes.js";

const routes = [
  ["post", "/create"],
  ["get", "/invoices"],
  ["get", "/invoices/:id/pdf"],
  ["post", "/invoices/:id/send-whatsapp"],
  ["get", "/report/excel"],
  ["get", "/:id"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("sales router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("sales router mounts the expected middleware chain", () => {
  assert.equal(
    router.stack.filter((layer) => !layer.route).length >= 2,
    true,
    "tenant and auth middlewares must guard the router",
  );
});

test("sales router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});
