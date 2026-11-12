import test from "node:test";
import assert from "node:assert/strict";
import router from "./whatsapp.routes.js";

const routes = [
  ["get", "/settings"],
  ["put", "/settings"],
  ["get", "/status"],
  ["get", "/connect"],
  ["post", "/disconnect"],
  ["post", "/bulk"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("whatsapp router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("whatsapp router mounts the expected middleware chain", () => {
  assert.equal(
    router.stack.filter((layer) => !layer.route).length >= 2,
    true,
    "tenant and auth middlewares must guard the router",
  );
});

test("whatsapp router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});
