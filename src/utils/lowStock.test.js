import test from "node:test";
import assert from "node:assert/strict";
import { totalStockMeters, isLowStock, LOW_STOCK_SQL } from "./lowStock.js";

test("totalStockMeters multiplies per-unit length by the unit count", () => {
  assert.equal(totalStockMeters({ length_m: 40, quantity: 3 }), 120);
  assert.equal(totalStockMeters({ length_m: "1.5", quantity: "10" }), 15);
  assert.equal(totalStockMeters({ length_m: 25, quantity: 1 }), 25);
  assert.equal(totalStockMeters(), 0);
});

test("a single long roll is not low stock even below the unit limit", () => {
  assert.equal(isLowStock({ length_m: 100, quantity: 1, min_stock_level: 5 }), false);
});

test("stock is compared with the limit in meters", () => {
  assert.equal(isLowStock({ length_m: 2, quantity: 3, min_stock_level: 10 }), true);
  assert.equal(isLowStock({ length_m: 4, quantity: 3, min_stock_level: 10 }), false);
  assert.equal(isLowStock({ length_m: 0, quantity: 5, min_stock_level: 5 }), true);
});

test("a missing limit is treated as zero", () => {
  assert.equal(isLowStock({ length_m: 10, quantity: 1 }), false);
  assert.equal(isLowStock({ length_m: 0, quantity: 1 }), true);
});

test("the SQL twin matches the helper formula", () => {
  assert.match(LOW_STOCK_SQL, /COALESCE\(length_m, 0\) \* COALESCE\(quantity, 0\)/);
  assert.match(LOW_STOCK_SQL, /<= COALESCE\(min_stock_level, 0\)/);
});
