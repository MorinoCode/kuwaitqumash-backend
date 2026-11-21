import test from "node:test";
import assert from "node:assert/strict";
import sequelize from "../../config/database.js";
import Customer from "./customer.model.js";
import { getCustomerAnalytics } from "./customer.controller.js";

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

const stubDb = (t, { customerRow, queryResults }) => {
  const origSchema = Customer.schema;
  const origQuery = sequelize.query;
  let queryIdx = 0;
  const capturedSql = [];

  Customer.schema = () => ({ findByPk: async () => customerRow });
  sequelize.query = async (sql) => {
    capturedSql.push(sql);
    return queryResults[queryIdx++] || [];
  };

  t.after(() => {
    Customer.schema = origSchema;
    sequelize.query = origQuery;
  });

  return capturedSql;
};

test("getCustomerAnalytics: blocks non-owner accessing another branch customer", async (t) => {
  stubDb(t, { customerRow: { id: 10, branch_id: 2 }, queryResults: [] });
  const res = makeRes();
  await getCustomerAnalytics(
    {
      tenant: { db_schema: "tenant_test" },
      params: { id: "10" },
      user: { role: "sales_man", branch_id: 1 },
    },
    res,
  );
  assert.equal(res.statusCode, 403);
});

test("getCustomerAnalytics: computes VIP net-of-refund metrics and holiday insights in Kuwait timezone", async (t) => {
  const capturedSql = stubDb(t, {
    customerRow: { id: 12, branch_id: 1 },
    queryResults: [
      [
        {
          purchase_frequency: 10,
          gross_spent: "2200.000",
          first_purchase: "2025-11-05T10:00:00Z",
          last_purchase: "2026-01-20T10:00:00Z",
          holiday_purchases: 6,
          avg_days_between_purchases: 8.4,
        },
      ],
      [
        {
          refunded_amount: "200.000",
          refunded_items: 1,
          refunded_meters: "5.000",
          refunded_cost: "80.000",
        },
      ],
      [
        {
          total_items: 16,
          total_meters: "85.000",
          gross_item_sell: "2200.000",
          gross_cost: "1080.000",
        },
      ],
      [{ fabric_type: "Linen", pattern: "Striped", total_qty: 16 }],
      [{ day_of_week: 5, cnt: 4 }], // Friday
      [{ month_idx: 11, cnt: 5 }], // December
      [{ month_idx: 10 }, { month_idx: 11 }, { month_idx: 0 }],
    ],
  });

  const res = makeRes();
  await getCustomerAnalytics(
    {
      tenant: { db_schema: "tenant_test" },
      params: { id: "12" },
      user: { role: "store_owner", branch_id: 1 },
    },
    res,
  );

  assert.equal(res.statusCode, 200);
  const { analysis } = res.body.data;
  assert.equal(analysis.customer_type, "vip_customer");
  // Net spent = 2200 - 200 = 2000; Net profit = 2000 - (1080 - 80) = 1000
  assert.equal(analysis.behavior.total_spent, "2000.000");
  assert.equal(analysis.behavior.total_items, 15);
  assert.equal(analysis.behavior.total_meters, "80.000");
  assert.equal(analysis.behavior.total_profit, "1000.000");
  assert.equal(analysis.behavior.best_buying_day, "Friday");
  assert.equal(analysis.behavior.best_buying_month, "December");
  assert.ok(analysis.insights.includes("holiday_shopper"));
  assert.ok(analysis.insights.includes("consistent_buyer"));
  assert.ok(analysis.insights.includes("profitable_customer"));
  assert.ok(
    capturedSql.some((s) => s.includes("Asia/Kuwait")),
    "SQL queries must use Kuwait timezone",
  );
});
