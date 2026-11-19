import test from "node:test";
import assert from "node:assert/strict";
import { addItem } from "../src/domains/inventory/inventory.controller.js";
import InventoryItem from "../src/domains/inventory/item.model.js";
import Branch from "../src/domains/store/branch.model.js";

test("addItem blocks non-owner from specifying a different branch_id", async () => {
  const req = {
    tenant: { db_schema: "tenant_test", id: 1, slug: "test" },
    user: { id: 10, role: "sales_man", branch_id: 1 },
    body: {
      fabric_type: "Silk",
      length_m: 25,
      cost_per_meter: 5,
      price_per_meter: 8,
      branch_id: 2, // different from user's branch 1
    },
    files: [],
  };

  let statusCode;
  let jsonBody;
  const res = {
    status: (code) => {
      statusCode = code;
      return {
        json: (data) => {
          jsonBody = data;
        },
      };
    },
    json: (data) => {
      jsonBody = data;
    },
  };

  await addItem(req, res);
  assert.equal(statusCode, 403);
  assert.match(jsonBody.message, /Access denied/);
});

test("addItem blocks non-owner without an assigned branch", async () => {
  const req = {
    tenant: { db_schema: "tenant_test", id: 1, slug: "test" },
    user: { id: 10, role: "sales_man", branch_id: null },
    body: {
      fabric_type: "Silk",
      length_m: 25,
      cost_per_meter: 5,
      price_per_meter: 8,
    },
    files: [],
  };

  let statusCode;
  let jsonBody;
  const res = {
    status: (code) => {
      statusCode = code;
      return {
        json: (data) => {
          jsonBody = data;
        },
      };
    },
    json: (data) => {
      jsonBody = data;
    },
  };

  await addItem(req, res);
  assert.equal(statusCode, 403);
  assert.match(jsonBody.message, /not assigned to any branch/);
});

test("addItem rejects duplicate custom barcode", async () => {
  const originalSchema = InventoryItem.schema;
  InventoryItem.schema = () => ({
    findOne: async () => ({ id: 99, barcode: "BAR12345" }),
  });

  const req = {
    tenant: { db_schema: "tenant_test", id: 1, slug: "test" },
    user: { id: 1, role: "store_owner", branch_id: 1 },
    body: {
      fabric_type: "Cotton",
      length_m: 50,
      cost_per_meter: 2,
      price_per_meter: 4,
      barcode: "BAR12345",
      branch_id: 1,
    },
    files: [],
  };

  let statusCode;
  let jsonBody;
  const res = {
    status: (code) => {
      statusCode = code;
      return {
        json: (data) => {
          jsonBody = data;
        },
      };
    },
    json: (data) => {
      jsonBody = data;
    },
  };

  try {
    // Stub branch lookup
    const origBranchSchema = Branch.schema;
    Branch.schema = () => ({
      findByPk: async () => ({ id: 1 }),
    });

    await addItem(req, res);
    assert.equal(statusCode, 400);
    assert.match(jsonBody.message, /Barcode already exists/);
    Branch.schema = origBranchSchema;
  } finally {
    InventoryItem.schema = originalSchema;
  }
});

test("addItem passes all extended fabric fields including zero price to create", async () => {
  const originalSchema = InventoryItem.schema;
  let createdPayload = null;

  InventoryItem.schema = () => ({
    findOne: async () => null,
    create: async (payload) => {
      createdPayload = payload;
      return {
        id: 101,
        ...payload,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    },
  });

  const origBranchSchema = Branch.schema;
  Branch.schema = () => ({
    findByPk: async () => ({ id: 1 }),
  });

  const req = {
    tenant: { db_schema: "tenant_test", id: 1, slug: "test" },
    user: { id: 1, role: "store_owner", branch_id: 1 },
    body: {
      fabric_type: "Linen",
      item_name: "Premium Linen",
      item_name_ar: "كتان فاخر",
      composition: "100% Linen",
      unit: "roll",
      width_cm: "150.5",
      roll_length_m: "30",
      length_m: "30",
      cost_per_meter: "5",
      price_per_meter: "0", // Zero price check!
      barcode: "CUSTOM-LINEN-01",
      branch_id: 1,
    },
  };

  let statusCode;
  let jsonBody;
  const res = {
    status: (code) => {
      statusCode = code;
      return {
        json: (data) => {
          jsonBody = data;
        },
      };
    },
    json: (data) => {
      jsonBody = data;
    },
  };

  try {
    await addItem(req, res);
    assert.equal(statusCode, 201);
    assert.ok(jsonBody.data, "responseData returned in jsonBody");
    assert.ok(createdPayload, "create must be called");
    assert.equal(createdPayload.composition, "100% Linen");
    assert.equal(createdPayload.unit, "roll");
    assert.equal(createdPayload.width_cm, 150.5);
    assert.equal(createdPayload.roll_length_m, 30);
    assert.equal(createdPayload.price_per_meter, 0); // Zero price preserved!
    assert.equal(createdPayload.barcode, "CUSTOM-LINEN-01");
    assert.equal(createdPayload.branch_id, 1);
  } finally {
    InventoryItem.schema = originalSchema;
    Branch.schema = origBranchSchema;
  }
});
