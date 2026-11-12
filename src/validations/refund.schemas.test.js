import test from "node:test";
import assert from "node:assert/strict";
import { createRefundBody } from "./refund.schemas.js";

const valid = {
  invoice_id: 12,
  items: [{ invoice_item_id: 4, quantity_refunded: 2, amount_refunded: 5.5 }],
  payments: [{ method: "Cash", amount: 5.5 }],
};

test("createRefundBody accepts a valid refund", () => {
  const parsed = createRefundBody.parse(valid);
  assert.equal(parsed.invoice_id, 12);
  assert.equal(parsed.items.length, 1);
});

test("createRefundBody coerces numeric strings", () => {
  const parsed = createRefundBody.parse({
    invoice_id: "12",
    items: [{ invoice_item_id: "4", quantity_refunded: "2", amount_refunded: "5.5" }],
    payments: [{ method: "Cash", amount: "5.5" }],
  });
  assert.equal(parsed.invoice_id, 12);
  assert.equal(parsed.items[0].invoice_item_id, 4);
});

test("createRefundBody requires at least one item", () => {
  assert.equal(createRefundBody.safeParse({ ...valid, items: [] }).success, false);
});

test("createRefundBody requires at least one payment", () => {
  assert.equal(createRefundBody.safeParse({ ...valid, payments: [] }).success, false);
});

test("createRefundBody rejects a non-positive quantity", () => {
  assert.equal(
    createRefundBody.safeParse({
      ...valid,
      items: [{ invoice_item_id: 1, quantity_refunded: 0, amount_refunded: 1 }],
    }).success,
    false,
  );
});

test("createRefundBody restricts payment methods", () => {
  assert.equal(
    createRefundBody.safeParse({
      ...valid,
      payments: [{ method: "Crypto", amount: 1 }],
    }).success,
    false,
  );
});

test("createRefundBody accepts a K-Net payment with reference", () => {
  assert.equal(
    createRefundBody.safeParse({
      ...valid,
      payments: [{ method: "K-Net", amount: 2, reference_number: "REF1" }],
    }).success,
    true,
  );
});
