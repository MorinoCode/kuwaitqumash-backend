import test from "node:test";
import assert from "node:assert/strict";
import {
  applyAssociations,
  User,
  Branch,
  Invoice,
  InvoiceItem,
  Customer,
  InventoryItem,
  Refund,
  RefundItem,
} from "./associations.js";

test("associations: applies all multi-tenant model associations cleanly", () => {
  // Calling applyAssociations multiple times is idempotent
  applyAssociations();
  applyAssociations();

  // Verify User <-> Branch
  assert.ok(User.associations.branch, "User should belong to Branch as 'branch'");
  assert.ok(Branch.associations.Users, "Branch should have many Users");

  // Verify Customer <-> Invoice
  assert.ok(Customer.associations.Invoices, "Customer should have many Invoices");
  assert.ok(Invoice.associations.customer, "Invoice should belong to Customer");
  assert.ok(Invoice.associations.creator, "Invoice should belong to User as 'creator'");
  assert.ok(Invoice.associations.branch, "Invoice should belong to Branch");
  assert.ok(Invoice.associations.items, "Invoice should have many InvoiceItems as 'items'");
  assert.ok(Invoice.associations.payments, "Invoice should have many InvoicePayments as 'payments'");
  assert.ok(Invoice.associations.refunds, "Invoice should have many Refunds as 'refunds'");

  // Verify Refund associations
  assert.ok(Refund.associations.invoice, "Refund should belong to Invoice as 'invoice'");
  assert.ok(Refund.associations.items, "Refund should have many RefundItems as 'items'");
  assert.ok(RefundItem.associations.invoice_item, "RefundItem should belong to InvoiceItem");
  assert.ok(RefundItem.associations.inventory_item, "RefundItem should belong to InventoryItem");

  // Verify InventoryItem <-> InvoiceItem
  assert.ok(InvoiceItem.associations.inventory_item, "InvoiceItem should belong to InventoryItem");
  assert.ok(InventoryItem.associations.InvoiceItems, "InventoryItem should have many InvoiceItems");
});
