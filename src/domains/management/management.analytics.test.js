import test from "node:test";
import assert from "node:assert/strict";
import sequelize from "../../config/database.js";
import User from "../auth/user.model.js";
import { getStaffAnalytics } from "./management.controller.js";

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
  return res;
};

const stubDb = (t, { userRow, queryResults }) => {
  const origSchema = User.schema;
  const origQuery = sequelize.query;
  let queryIdx = 0;
  const capturedSql = [];

  User.schema = () => ({ findByPk: async () => userRow });
  sequelize.query = async (sql) => {
    capturedSql.push(sql);
    return queryResults[queryIdx++] || [];
  };

  t.after(() => {
    User.schema = origSchema;
    sequelize.query = origQuery;
  });

  return capturedSql;
};

test("getStaffAnalytics: rejects invalid schema or staff id", async () => {
  const res1 = makeRes();
  await getStaffAnalytics(
    { tenant: { db_schema: "bad;schema" }, params: { id: "1" }, user: { role: "store_owner" } },
    res1,
  );
  assert.equal(res1.statusCode, 400);

  const res2 = makeRes();
  await getStaffAnalytics(
    { tenant: { db_schema: "tenant_test" }, params: { id: "abc" }, user: { role: "store_owner" } },
    res2,
  );
  assert.equal(res2.statusCode, 400);
});

test("getStaffAnalytics: blocks branch_manager from viewing another branch's staff", async (t) => {
  stubDb(t, { userRow: { id: 5, branch_id: 2 }, queryResults: [] });
  const res = makeRes();
  await getStaffAnalytics(
    {
      tenant: { db_schema: "tenant_test" },
      params: { id: "5" },
      user: { role: "branch_manager", branch_id: 1 },
    },
    res,
  );
  assert.equal(res.statusCode, 403);
});

test("getStaffAnalytics: returns new_staff when staff has zero invoices", async (t) => {
  stubDb(t, {
    userRow: { id: 3, branch_id: 1 },
    queryResults: [[{ total_invoices: 0 }], [{}], [{}], [], [], [], []],
  });
  const res = makeRes();
  await getStaffAnalytics(
    {
      tenant: { db_schema: "tenant_test" },
      params: { id: "3" },
      user: { role: "store_owner", branch_id: 1 },
    },
    res,
  );
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.analysis.performance_level, "new_staff");
});

test("getStaffAnalytics: aggregates net-of-refund metrics in Kuwait timezone via SQL", async (t) => {
  const capturedSql = stubDb(t, {
    userRow: { id: 7, branch_id: 1 },
    queryResults: [
      [
        {
          total_invoices: 25,
          gross_sales: "6500.000",
          unique_customers: 18,
          first_sale: "2026-01-10T08:00:00Z",
          last_sale: "2026-03-20T08:00:00Z",
          avg_days_between_sales: 2.8,
        },
      ],
      [
        {
          refunded_amount: "500.000",
          refunded_items: 2,
          refunded_meters: "10.000",
          refunded_cost: "200.000",
        },
      ],
      [
        {
          total_items: 42,
          total_meters: "210.000",
          gross_item_sell: "6500.000",
          gross_cost: "3200.000",
        },
      ],
      [
        { fabric_type: "Silk", pattern: "Floral", total_qty: 30 },
        { fabric_type: "Cotton", pattern: "Solid", total_qty: 12 },
      ],
      [{ day_of_week: 4, cnt: 10 }], // Thursday
      [{ month_idx: 2, cnt: 12 }], // March
      [{ month_idx: 0 }, { month_idx: 1 }, { month_idx: 2 }],
    ],
  });

  const res = makeRes();
  await getStaffAnalytics(
    {
      tenant: { db_schema: "tenant_test" },
      params: { id: "7" },
      user: { role: "store_owner", branch_id: 1 },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  const { analysis } = res.body.data;
  assert.equal(analysis.performance_level, "good_performer");
  assert.equal(analysis.preferences.preferred_fabric_type, "Silk");
  assert.equal(analysis.preferences.preferred_pattern, "Floral");
  // Net sales = 6500 - 500 = 6000; Net profit = (6500 - 500) - (3200 - 200) = 3000
  assert.equal(analysis.behavior.total_sales, "6000.000");
  assert.equal(analysis.behavior.total_items, 40);
  assert.equal(analysis.behavior.total_meters, "200.000");
  assert.equal(analysis.behavior.total_profit, "3000.000");
  assert.equal(analysis.behavior.best_selling_day, "Thursday");
  assert.equal(analysis.behavior.best_selling_month, "March");
  assert.ok(analysis.insights.includes("high_volume_seller"));
  assert.ok(analysis.insights.includes("profitable_seller"));
  assert.ok(analysis.insights.includes("consistent_performer"));
  assert.ok(
    capturedSql.some((s) => s.includes("Asia/Kuwait")),
    "SQL queries must aggregate dates in Kuwait timezone",
  );
});
