import test from "node:test";
import assert from "node:assert/strict";
import { loginBody } from "./auth.schemas.js";

test("accepts a valid username and password", () => {
  const result = loginBody.safeParse({ username: "admin_qumash", password: "123456" });
  assert.equal(result.success, true);
  assert.equal(result.data.username, "admin_qumash");
});

test("lowercases and trims the username", () => {
  const result = loginBody.safeParse({ username: "  Admin_Qumash ", password: "x" });
  assert.equal(result.success, true);
  assert.equal(result.data.username, "admin_qumash");
});

test("rejects an empty username", () => {
  const result = loginBody.safeParse({ username: "", password: "x" });
  assert.equal(result.success, false);
});

test("rejects characters outside letters, numbers, dot, dash and underscore", () => {
  const result = loginBody.safeParse({ username: "admin qumash!", password: "x" });
  assert.equal(result.success, false);
});

test("rejects unknown fields because the schema is strict", () => {
  const result = loginBody.safeParse({
    username: "admin",
    password: "x",
    role: "store_owner",
  });
  assert.equal(result.success, false);
});
