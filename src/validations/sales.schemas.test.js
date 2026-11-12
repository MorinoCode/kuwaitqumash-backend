import test from "node:test";
import assert from "node:assert/strict";
import { createSaleBody } from "./sales.schemas.js";

const validSale = {
  customer_id: 1,
  items: [
    { id: 3, meters: 2.5, price_per_meter: 4, total_price: 10 },
  ],
  payments: [{ method: "Cash", amount: 10 }],
};

test("accepts a minimal valid sale", () => {
  const result = createSaleBody.safeParse(validSale);
  assert.equal(result.success, true);
  assert.equal(result.data.items[0].quantity, 1);
  assert.equal(result.data.items[0].discount, 0);
});

test("converts Persian digits in amounts and meters", () => {
  const result = createSaleBody.safeParse({
    ...validSale,
    items: [{ id: 3, meters: "۲.۵", price_per_meter: "۴", total_price: "۱۰" }],
    payments: [{ method: "Cash", amount: "۱۰" }],
  });
  assert.equal(result.success, true);
  assert.equal(result.data.items[0].meters, 2.5);
  assert.equal(result.data.items[0].price_per_meter, 4);
  assert.equal(result.data.payments[0].amount, 10);
});

test("rejects a sale without items", () => {
  const result = createSaleBody.safeParse({ ...validSale, items: [] });
  assert.equal(result.success, false);
});

test("rejects an unknown payment method", () => {
  const result = createSaleBody.safeParse({
    ...validSale,
    payments: [{ method: "Bitcoin", amount: 10 }],
  });
  assert.equal(result.success, false);
});

test("moves a legacy reference field into reference_number", () => {
  const result = createSaleBody.safeParse({
    ...validSale,
    payments: [{ method: "K-Net", amount: 10, reference: "TX-1" }],
  });
  assert.equal(result.success, true);
  assert.equal(result.data.payments[0].reference_number, "TX-1");
});

test("rejects an item id that is not a positive integer", () => {
  const result = createSaleBody.safeParse({
    ...validSale,
    items: [{ id: 0, meters: 1, price_per_meter: 1, total_price: 1 }],
  });
  assert.equal(result.success, false);
});
