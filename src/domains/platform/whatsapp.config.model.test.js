import test from "node:test";
import assert from "node:assert/strict";
import Model from "./whatsapp.config.model.js";

test("whatsapp.config model exposes a table and a primary key", () => {
  assert.ok(Model, "model should be exported");
  const tableName = Model.getTableName();
  const resolved =
    typeof tableName === "string"
      ? tableName
      : tableName.tableName || tableName.table || "";
  assert.ok(resolved.length > 0, "model should resolve to a table name");
  const primaryKeys = Object.values(Model.rawAttributes).filter((a) => a.primaryKey);
  assert.ok(primaryKeys.length > 0, "model should define a primary key");
  assert.ok(Object.keys(Model.rawAttributes).length > 2);
});

test("whatsapp.config model declares its indexes", () => {
  assert.ok(Array.isArray(Model.options.indexes));
});
