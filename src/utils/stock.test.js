import test from "node:test";
import assert from "node:assert/strict";
import { applySaleToStock, applyRefundToStock } from "./stock.js";

test("applySaleToStock removes sold meters from the roll", () => {
  const result = applySaleToStock({ length_m: 10, quantity: 2 }, 3.5, 1);
  assert.equal(result.ok, true);
  assert.equal(result.availableMeters, 20);
  assert.equal(result.soldMeters, 3.5);
  assert.equal(result.remainingMeters, 16.5);
  assert.equal(result.status, "In Stock");
});

test("applySaleToStock multiplies meters by the sold units", () => {
  const result = applySaleToStock({ length_m: 10, quantity: 2 }, 2, 3);
  assert.equal(result.soldMeters, 6);
  assert.equal(result.remainingMeters, 14);
});

test("applySaleToStock rejects a sale without meters", () => {
  const result = applySaleToStock({ length_m: 10, quantity: 2 }, 0, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-meters");
});

test("applySaleToStock rejects a sale larger than the roll", () => {
  const result = applySaleToStock({ length_m: 5, quantity: 1 }, 6, 1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "insufficient");
  assert.equal(result.availableMeters, 5);
});

test("applySaleToStock marks the roll sold out when nothing is left", () => {
  const result = applySaleToStock({ length_m: 4, quantity: 1 }, 4, 1);
  assert.equal(result.ok, true);
  assert.equal(result.quantity, 0);
  assert.equal(result.length_m, 0);
  assert.equal(result.status, "Sold");
});

test("applyRefundToStock restores meters to the item", () => {
  const result = applyRefundToStock({ length_m: 5, quantity: 1 }, 2, 1);
  assert.equal(result.restoredMeters, 2);
  assert.equal(result.totalMeters, 7);
});

test("applyRefundToStock uses at least one roll for an empty item", () => {
  const result = applyRefundToStock({ length_m: 0, quantity: 0 }, 3, 1);
  assert.equal(result.quantity, 1);
  assert.equal(result.length_m, 3);
});
