import test from "node:test";
import assert from "node:assert/strict";
import { generateUniqueBarcode } from "./barcode.js";

const modelWithExisting = (existing) => ({
  findOne: async ({ where }) => (existing.includes(where.barcode) ? { id: 1 } : null),
});

test("builds a barcode from fabric, design and variant codes", async () => {
  const barcode = await generateUniqueBarcode(
    modelWithExisting([]),
    "Chiffon",
    "Floral",
    3,
  );
  assert.match(barcode, /^CH-FLO-30-[0-9A-Z]{8}$/);
});

test("falls back to GEN and 00 for missing design and variant", async () => {
  const barcode = await generateUniqueBarcode(modelWithExisting([]), null);
  assert.match(barcode, /^FB-GEN-00-[0-9A-Z]{8}$/);
});

test("normalizes Arabic digits inside the variant", async () => {
  const barcode = await generateUniqueBarcode(
    modelWithExisting([]),
    "Silk",
    "Plain",
    "٥",
  );
  assert.match(barcode, /^SI-PLA-50-[0-9A-Z]{8}$/);
});

test("retries until the generated barcode is unique", async () => {
  const seen = new Set();
  const model = {
    findOne: async ({ where }) => {
      const duplicate = seen.size === 0;
      seen.add(where.barcode);
      return duplicate ? { id: 1 } : null;
    },
  };
  const barcode = await generateUniqueBarcode(model, "Wool", "Rib", 1);
  assert.match(barcode, /^WO-RIB-10-[0-9A-Z]{8}$/);
});
