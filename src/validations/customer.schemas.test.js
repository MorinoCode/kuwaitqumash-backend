import test from "node:test";
import assert from "node:assert/strict";
import { createCustomerBody, updateCustomerBody } from "./customer.schemas.js";

const valid = { full_name: "Ali Hassan", phone: "96512345678" };

test("createCustomerBody accepts a minimal customer", () => {
  const parsed = createCustomerBody.parse(valid);
  assert.equal(parsed.full_name, "Ali Hassan");
});

test("createCustomerBody trims the name and phone", () => {
  const parsed = createCustomerBody.parse({
    full_name: "  Sara  ",
    phone: "  5555  ",
  });
  assert.equal(parsed.full_name, "Sara");
  assert.equal(parsed.phone, "5555");
});

test("createCustomerBody requires a name", () => {
  const result = createCustomerBody.safeParse({ phone: "123" });
  assert.equal(result.success, false);
});

test("createCustomerBody rejects unknown fields", () => {
  const result = createCustomerBody.safeParse({ ...valid, national_id: "123" });
  assert.equal(result.success, false);
});

test("createCustomerBody validates the customer type", () => {
  assert.equal(
    createCustomerBody.safeParse({ ...valid, type: "VIP" }).success,
    true,
  );
  assert.equal(
    createCustomerBody.safeParse({ ...valid, type: "Gold" }).success,
    false,
  );
});

test("createCustomerBody validates gender values", () => {
  assert.equal(createCustomerBody.safeParse({ ...valid, gender: "F" }).success, true);
  assert.equal(createCustomerBody.safeParse({ ...valid, gender: "X" }).success, false);
});

test("createCustomerBody coerces branch_id to a number", () => {
  const parsed = createCustomerBody.parse({ ...valid, branch_id: "3" });
  assert.equal(parsed.branch_id, 3);
});

test("updateCustomerBody allows an empty patch", () => {
  assert.deepEqual(updateCustomerBody.parse({}), {});
});

test("updateCustomerBody rejects a blank name when provided", () => {
  assert.equal(updateCustomerBody.safeParse({ full_name: "" }).success, false);
});

test("updateCustomerBody accepts null address", () => {
  assert.equal(updateCustomerBody.safeParse({ address: null }).success, true);
});
