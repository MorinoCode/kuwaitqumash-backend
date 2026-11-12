import test from "node:test";
import assert from "node:assert/strict";
import { registerBody, whatsappBulkBody } from "./platform.schemas.js";

const signup = {
  store_name: "Kuwait Qumash",
  owner_name: "Ali",
  phone: "96512345678",
  username: "Owner",
  password: "secret1",
};

test("registerBody normalises the username to lowercase", () => {
  const parsed = registerBody.parse(signup);
  assert.equal(parsed.username, "owner");
});

test("registerBody normalises Arabic-Indic phone digits", () => {
  const parsed = registerBody.parse({ ...signup, phone: "٩٦٥١٢٣٤٥٦٧٨" });
  assert.equal(parsed.phone, "96512345678");
});

test("registerBody strips spaces from the phone", () => {
  const parsed = registerBody.parse({ ...signup, phone: "965 1234 5678" });
  assert.equal(parsed.phone, "96512345678");
});

test("registerBody rejects a short password", () => {
  assert.equal(registerBody.safeParse({ ...signup, password: "123" }).success, false);
});

test("registerBody rejects a short phone", () => {
  assert.equal(registerBody.safeParse({ ...signup, phone: "123" }).success, false);
});

test("registerBody rejects unknown fields", () => {
  assert.equal(registerBody.safeParse({ ...signup, plan: "pro" }).success, false);
});

test("whatsappBulkBody defaults the delay to 3000ms", () => {
  const parsed = whatsappBulkBody.parse({
    segment: "all",
    message: "Hello",
  });
  assert.equal(parsed.delay_ms, 3000);
});

test("whatsappBulkBody rejects an unknown segment", () => {
  assert.equal(
    whatsappBulkBody.safeParse({ segment: "everyone", message: "Hi" }).success,
    false,
  );
});

test("whatsappBulkBody enforces the delay bounds", () => {
  assert.equal(
    whatsappBulkBody.safeParse({ segment: "all", message: "Hi", delay_ms: 100 })
      .success,
    false,
  );
  assert.equal(
    whatsappBulkBody.safeParse({ segment: "all", message: "Hi", delay_ms: 90000 })
      .success,
    false,
  );
});

test("whatsappBulkBody requires a message", () => {
  assert.equal(whatsappBulkBody.safeParse({ segment: "all" }).success, false);
});
