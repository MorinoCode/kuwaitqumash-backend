import test from "node:test";
import assert from "node:assert/strict";
import { applySaleToStock, applyRefundToStock } from "../src/utils/stock.js";

test("partial cut from one roll keeps the roll and reduces meters", () => {
  const r = applySaleToStock({ length_m: 30, quantity: 1 }, 2.5, 1);
  assert.equal(r.ok, true);
  assert.equal(r.quantity, 1);
  assert.equal(r.length_m, 27.5);
  assert.equal(r.status, "In Stock");
});

test("selling the whole roll empties stock and marks it sold", () => {
  const r = applySaleToStock({ length_m: 30, quantity: 1 }, 30, 1);
  assert.equal(r.ok, true);
  assert.equal(r.quantity, 0);
  assert.equal(r.length_m, 0);
  assert.equal(r.status, "Sold");
});

test("selling more meters than available is rejected", () => {
  const r = applySaleToStock({ length_m: 30, quantity: 1 }, 31, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "insufficient");
  assert.equal(r.availableMeters, 30);
});

test("multi-roll sale keeps total meters exact", () => {
  const r = applySaleToStock({ length_m: 30, quantity: 3 }, 5, 2);
  assert.equal(r.ok, true);
  assert.equal(r.remainingMeters, 80);
  assert.equal(r.quantity, 3);
  assert.ok(Math.abs(r.length_m * 3 - 80) < 0.002);
});

test("a sale that eats whole rolls shrinks the roll count", () => {
  const r = applySaleToStock({ length_m: 30, quantity: 2 }, 25, 2);
  assert.equal(r.ok, true);
  assert.equal(r.remainingMeters, 10);
  assert.equal(r.quantity, 1);
  assert.equal(r.length_m, 10);
});

test("zero meters cannot be sold", () => {
  const r = applySaleToStock({ length_m: 30, quantity: 1 }, 0, 1);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "invalid-meters");
});

test("refund restores a sold-out roll", () => {
  const r = applyRefundToStock({ length_m: 0, quantity: 0 }, 30, 1);
  assert.equal(r.quantity, 1);
  assert.equal(r.length_m, 30);
});

test("refund of a partial cut restores the meters", () => {
  const r = applyRefundToStock({ length_m: 27.5, quantity: 1 }, 2.5, 1);
  assert.equal(r.quantity, 1);
  assert.equal(r.length_m, 30);
});

test("refund is additive on top of existing stock", () => {
  const r = applyRefundToStock({ length_m: 20, quantity: 2 }, 10, 1);
  assert.equal(r.totalMeters, 50);
  assert.ok(Math.abs(r.length_m * r.quantity - 50) < 0.002);
});
