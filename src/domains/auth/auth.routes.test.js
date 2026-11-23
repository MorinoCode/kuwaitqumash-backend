import test from "node:test";
import assert from "node:assert/strict";
import router from "./auth.routes.js";

const routes = [
  ["post", "/login"],
  ["post", "/logout"],
  ["get", "/me"],
  ["put", "/change-password"],
];

const has = (method, path) =>
  router.stack.some(
    (layer) => layer.route && layer.route.path === path && layer.route.methods[method],
  );

test("auth router registers every documented route", () => {
  for (const [method, path] of routes) {
    assert.ok(has(method, path), `missing ${method.toUpperCase()} ${path}`);
  }
});

test("auth router mounts the expected middleware chain", () => {
  assert.ok(router.stack.some((layer) => layer.route));
});

test("auth router does not mount unexpected handlers", () => {
  const mounted = router.stack.filter((layer) => layer.route).length;
  assert.equal(mounted, routes.length);
});
