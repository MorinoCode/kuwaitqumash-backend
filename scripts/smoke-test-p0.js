import "../src/config/env.js";
import sequelize from "../src/config/database.js";
import "../src/domains/associations.js";
import Tenant from "../src/domains/platform/tenant.model.js";
import User from "../src/domains/auth/user.model.js";
import Customer from "../src/domains/customers/customer.model.js";
import {
  getOwnerDashboard,
  getManagerDashboard,
  getSalesmanDashboard,
  getDashboardAnalytics,
} from "../src/domains/dashboard/dashboard.controller.js";
import { getInvoices } from "../src/domains/sales/sales.controller.js";
import { getRefunds } from "../src/domains/sales/refund.controller.js";
import { getInventory } from "../src/domains/inventory/inventory.controller.js";
import {
  getCustomers,
  getCustomerAnalytics,
} from "../src/domains/customers/customer.controller.js";
import {
  getStaff,
  getStaffAnalytics,
} from "../src/domains/management/management.controller.js";
import {
  listTenants,
  listTenantUsers,
} from "../src/domains/admin/admin.controller.js";

const invoke = async (handler, req) => {
  let statusCode = 200;
  let body = null;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
      return this;
    },
  };
  await handler(req, res);
  return { statusCode, body };
};

const assertOk = (name, result) => {
  if (result.statusCode !== 200 || result.body?.success === false) {
    throw new Error(
      `[FAIL] ${name}: status=${result.statusCode}, body=${JSON.stringify(result.body)}`,
    );
  }
  console.log(`  ✓ ${name} (${result.statusCode})`);
};

const run = async () => {
  console.log("Running P0 Live Production Smoke Tests...\n");

  await sequelize.authenticate();
  console.log("  ✓ PostgreSQL connection established");

  const [ext] = await sequelize.query(
    `SELECT extname FROM pg_extension WHERE extname = 'pg_trgm'`,
    { type: sequelize.QueryTypes.SELECT },
  );
  if (!ext) {
    throw new Error("[FAIL] pg_trgm extension is not installed");
  }
  console.log("  ✓ pg_trgm extension active");

  const tenants = await Tenant.findAll({ order: [["id", "ASC"]], raw: true });
  if (tenants.length === 0) {
    console.log("  ! No tenants found in database; skipping tenant checks.");
    return;
  }

  // Prefer tenant with most data or first valid tenant
  const tenant =
    tenants.find((t) => t.slug === "qummash") ||
    tenants.find((t) => /^[a-zA-Z0-9_]+$/.test(t.db_schema));

  const schema = tenant.db_schema;
  const requiredIndexes = [
    "idx_invoices_created_by_status_created",
    "idx_inventory_item_name_trgm",
    "idx_inventory_barcode_trgm",
    "idx_customers_full_name_trgm",
    "idx_customers_phone_trgm",
    "idx_customers_address_trgm",
    "idx_invoices_invoice_number_trgm",
  ];

  const existingIdxRows = await sequelize.query(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname = ANY($2::text[])`,
    {
      bind: [schema, requiredIndexes],
      type: sequelize.QueryTypes.SELECT,
    },
  );
  const existingIdxSet = new Set(existingIdxRows.map((r) => r.indexname));
  const missingIdx = requiredIndexes.filter((name) => !existingIdxSet.has(name));
  if (missingIdx.length > 0) {
    throw new Error(
      `[FAIL] Missing required indexes in ${schema}: ${missingIdx.join(", ")}`,
    );
  }
  console.log(`  ✓ All ${requiredIndexes.length} required P0 indexes verified in ${schema}`);

  const sampleUser = (await User.schema(schema).findOne({ raw: true })) || {
    id: 1,
    branch_id: 1,
  };
  const ownerUser = {
    id: sampleUser.id,
    role: "store_owner",
    branch_id: sampleUser.branch_id || 1,
  };
  const managerUser = {
    id: sampleUser.id,
    role: "branch_manager",
    branch_id: sampleUser.branch_id || 1,
  };
  const salesmanUser = {
    id: sampleUser.id,
    role: "sales_man",
    branch_id: sampleUser.branch_id || 1,
  };

  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);

  assertOk(
    "getOwnerDashboard",
    await invoke(getOwnerDashboard, { tenant, user: ownerUser, query: {} }),
  );
  assertOk(
    "getManagerDashboard",
    await invoke(getManagerDashboard, { tenant, user: managerUser, query: {} }),
  );
  assertOk(
    "getSalesmanDashboard",
    await invoke(getSalesmanDashboard, { tenant, user: salesmanUser, query: {} }),
  );
  assertOk(
    "getDashboardAnalytics",
    await invoke(getDashboardAnalytics, {
      tenant,
      user: ownerUser,
      query: { startDate: monthAgo, endDate: today },
    }),
  );
  assertOk(
    "getInventory (with search)",
    await invoke(getInventory, {
      tenant,
      user: ownerUser,
      query: { search: "silk", page: "1", limit: "20" },
    }),
  );
  assertOk(
    "getCustomers (with search)",
    await invoke(getCustomers, {
      tenant,
      user: ownerUser,
      query: { search: "9", page: "1", limit: "20" },
    }),
  );
  assertOk(
    "getInvoices (paginated)",
    await invoke(getInvoices, {
      tenant,
      user: ownerUser,
      query: { page: "1", limit: "20" },
    }),
  );
  assertOk(
    "getRefunds (paginated)",
    await invoke(getRefunds, {
      tenant,
      user: ownerUser,
      query: { page: "1", limit: "20" },
    }),
  );
  assertOk(
    "getStaff (paginated)",
    await invoke(getStaff, {
      tenant,
      user: ownerUser,
      query: { page: "1", limit: "20" },
    }),
  );
  assertOk(
    "getStaffAnalytics",
    await invoke(getStaffAnalytics, {
      tenant,
      user: ownerUser,
      params: { id: String(sampleUser.id) },
    }),
  );

  const sampleCustomer = await Customer.schema(schema).findOne({ raw: true });
  if (sampleCustomer) {
    assertOk(
      "getCustomerAnalytics",
      await invoke(getCustomerAnalytics, {
        tenant,
        user: ownerUser,
        params: { id: String(sampleCustomer.id) },
      }),
    );
  }

  assertOk("admin.listTenants", await invoke(listTenants, {}));
  assertOk(
    "admin.listTenantUsers",
    await invoke(listTenantUsers, { params: { id: String(tenant.id) }, query: {} }),
  );

  console.log("\nAll P0 smoke checks passed!");
};

run()
  .catch((err) => {
    console.error("\nP0 Smoke Test Failed:", err?.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
