import test from "node:test";
import assert from "node:assert/strict";
import Model from "./invoice-item.model.js";

test("invoice item model exposes a table and the id primary key", () => {
  assert.ok(Model, "model should be exported");
  assert.equal(typeof Model.getTableName(), "string");
  assert.ok(Model.getTableName().length > 0);
  assert.ok(Model.rawAttributes.id, "model should define an id attribute");
  assert.equal(Model.rawAttributes.id.primaryKey, true);
  assert.ok(Object.keys(Model.rawAttributes).length > 2);
});

test("invoice item model declares its indexes", () => {
  assert.ok(Array.isArray(Model.options.indexes));
});
