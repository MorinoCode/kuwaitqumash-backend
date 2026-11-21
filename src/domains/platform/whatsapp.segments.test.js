import test from "node:test";
import assert from "node:assert/strict";
import sequelize from "../../config/database.js";
import { fetchSegmentCustomers } from "./whatsapp.controller.js";

const captureSql = (t) => {
  const origQuery = sequelize.query;
  const calls = [];
  sequelize.query = async (sql, opts) => {
    calls.push({ sql, opts });
    return [{ id: 1, phone: "99887766" }];
  };
  t.after(() => {
    sequelize.query = origQuery;
  });
  return calls;
};

test("fetchSegmentCustomers rejects invalid schema identifiers", async (t) => {
  const calls = captureSql(t);
  const rows = await fetchSegmentCustomers({
    schema: 'tenant_bad"; DROP TABLE users;--',
    segment: "all",
  });
  assert.deepEqual(rows, []);
  assert.equal(calls.length, 0);
});

test("fetchSegmentCustomers uses single SQL JOIN with Paid/Partially Refunded status for high_value_6m", async (t) => {
  const calls = captureSql(t);
  const rows = await fetchSegmentCustomers({
    schema: "tenant_test",
    segment: "high_value_6m",
    branch_id: 2,
  });
  assert.equal(rows.length, 1);
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /INNER JOIN/i);
  assert.match(calls[0].sql, /Paid.*Partially Refunded/);
  assert.equal(calls[0].opts.replacements.branchId, 2);
});

test("fetchSegmentCustomers uses NOT EXISTS for inactive_6m and EXISTS for last_30d", async (t) => {
  const calls = captureSql(t);
  await fetchSegmentCustomers({ schema: "tenant_test", segment: "inactive_6m" });
  await fetchSegmentCustomers({ schema: "tenant_test", segment: "last_30d" });
  assert.equal(calls.length, 2);
  assert.match(calls[0].sql, /NOT EXISTS/i);
  assert.match(calls[1].sql, /\bEXISTS\b/i);
  assert.doesNotMatch(calls[0].sql, /NOT IN/i);
});
