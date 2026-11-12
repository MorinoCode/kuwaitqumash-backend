import test from "node:test";
import assert from "node:assert/strict";
import * as schemas from "./index.js";

test("index re-exports every domain schema", () => {
  const names = [
    "loginBody",
    "registerBody",
    "createCustomerBody",
    "addItemBody",
    "createSaleBody",
    "createStaffBody",
  ];
  for (const name of names) {
    assert.ok(name in schemas, `missing export: ${name}`);
  }
});

test("every exported schema exposes safeParse", () => {
  for (const [name, schema] of Object.entries(schemas)) {
    assert.equal(typeof schema.safeParse, "function", `${name} is not a zod schema`);
  }
});
