import test from "node:test";
import assert from "node:assert/strict";
import {
  addItemBody,
  updateItemBody,
} from "./inventory.schemas.js";

const valid = { fabric_type: "Cotton", price_per_meter: 2.5 };

test("addItemBody accepts minimal input and applies defaults", () => {
  const parsed = addItemBody.parse(valid);
  assert.equal(parsed.unit, "meter");
  assert.equal(parsed.quantity, 1);
  assert.equal(parsed.length_m, 0);
  assert.equal(parsed.min_stock_level, 5);
  assert.equal(parsed.cost_per_meter, 0);
});

test("addItemBody requires a fabric type", () => {
  assert.equal(addItemBody.safeParse({ price_per_meter: 2 }).success, false);
});

test("addItemBody requires a price per meter", () => {
  assert.equal(addItemBody.safeParse({ fabric_type: "Silk" }).success, false);
});

test("addItemBody rejects negative prices", () => {
  assert.equal(
    addItemBody.safeParse({ ...valid, price_per_meter: -1 }).success,
    false,
  );
});

test("addItemBody coerces numeric strings", () => {
  const parsed = addItemBody.parse({
    ...valid,
    price_per_meter: "3.75",
    quantity: "4",
    width_cm: "150",
  });
  assert.equal(parsed.price_per_meter, 3.75);
  assert.equal(parsed.quantity, 4);
  assert.equal(parsed.width_cm, 150);
});

test("addItemBody restricts the unit enum", () => {
  assert.equal(addItemBody.safeParse({ ...valid, unit: "roll" }).success, true);
  assert.equal(addItemBody.safeParse({ ...valid, unit: "kg" }).success, false);
});

test("addItemBody rejects unknown fields", () => {
  assert.equal(addItemBody.safeParse({ ...valid, colour: "red" }).success, false);
});

test("updateItemBody allows a partial patch", () => {
  assert.deepEqual(updateItemBody.parse({}), {});
});

test("updateItemBody validates the status enum", () => {
  assert.equal(updateItemBody.safeParse({ status: "Reserved" }).success, true);
  assert.equal(updateItemBody.safeParse({ status: "Lost" }).success, false);
});
