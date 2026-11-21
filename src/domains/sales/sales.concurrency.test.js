import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

test("salesCreation.controller createSale pre-locks inventory in deterministic ascending ID order and uses bulkCreate", () => {
  const src = fs.readFileSync(path.join(__dirname, "salesCreation.controller.js"), "utf8");
  assert.match(src, /sort\(\(a,\s*b\)\s*=>\s*a\s*-\s*b\)/);
  assert.match(src, /order:\s*\[\["id",\s*"ASC"\]\],\s*transaction:\s*t,\s*lock:\s*t\.LOCK\.UPDATE/);
  assert.match(src, /InvoiceItem\.schema\(schema\)\.bulkCreate\(/);
  assert.match(src, /InvoicePayment\.schema\(schema\)\.bulkCreate\(/);
});

test("refund.controller createRefund uses per-tenant advisory lock (hashtext) and bulkCreate", () => {
  const src = fs.readFileSync(path.join(__dirname, "refund.controller.js"), "utf8");
  assert.match(src, /pg_advisory_xact_lock\(hashtext\(:lockKey\)\)/);
  assert.match(src, /refund_cn:\$\{schema\}/);
  assert.doesNotMatch(src, /const lockKey = 1000/);
  assert.match(src, /RefundItem\.schema\(schema\)\.bulkCreate\(/);
  assert.match(src, /RefundPayment\.schema\(schema\)\.bulkCreate\(/);
});
