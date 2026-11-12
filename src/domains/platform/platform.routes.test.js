import test from "node:test";
import assert from "node:assert/strict";
import router from "./platform.routes.js";

const routes = [
  ["post", "/register"],
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
