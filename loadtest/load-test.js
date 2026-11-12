/**
 * Load test for KuwaitQumash API (k6).
 *
 * Run against a staging/staging-like database, never against a live store:
 *   k6 run backend/loadtest/load-test.js
 *
 * Required input (login once and reuse the token):
 *   TOKEN=<jwt> TENANT=kuwaitqumash-fabrics INVOICE_ID=46 k6 run loads...
 *
 * Optional:
 *   BASE_URL (default http://127.0.0.1:5001), LIST_VUS, DASH_VUS, PDF_VUS,
 *   EXCEL_VUS, DURATION (default 30s)
 *
 * Notes:
 * - The dashboard caches per (store, date range). The "cached" scenario keeps
 *   one range to measure the warm path, "cold" rotates ranges to force the
 *   aggregation path.
 * - The Excel scenario aborts with HTTP 400 when the tenant has more rows than
 *   SALES_EXCEL_MAX_ROWS; that is a successful (non-5xx) response, so keep
 *   DURATION short on large datasets.
 */
import http from "k6/http";
import { check } from "k6";

const BASE = __ENV.BASE_URL || "http://127.0.0.1:5001";
const TENANT = __ENV.TENANT || "kuwaitqumash-fabrics";
const TOKEN = __ENV.TOKEN || "";
const INVOICE_ID = __ENV.INVOICE_ID || "1";
const DURATION = __ENV.DURATION || "30s";

const HEADERS = {
  "x-tenant-id": TENANT,
  Authorization: `Bearer ${TOKEN}`,
};

const rangeFor = (index) => {
  const startDay = String(1 + (index % 27)).padStart(2, "0");
  const startMonth = String(1 + (index % 10)).padStart(2, "0");
  return `startDate=2026-${startMonth}-${startDay}T00:00:00.000Z&endDate=2026-11-12T23:59:59.999Z`;
};

export const options = {
  scenarios: {
    list: {
      executor: "constant-vus",
      exec: "listInvoices",
      vus: Number(__ENV.LIST_VUS || 10),
      duration: DURATION,
    },
    dashboard_cached: {
      executor: "constant-vus",
      exec: "dashboardCached",
      vus: Number(__ENV.DASH_VUS || 5),
      duration: DURATION,
    },
    dashboard_cold: {
      executor: "constant-vus",
      exec: "dashboardCold",
      vus: Number(__ENV.DASH_VUS || 5),
      duration: DURATION,
      startTime: "2s",
    },
    pdf: {
      executor: "constant-vus",
      exec: "invoicePdf",
      vus: Number(__ENV.PDF_VUS || 10),
      duration: DURATION,
    },
    excel: {
      executor: "constant-vus",
      exec: "salesExcel",
      vus: Number(__ENV.EXCEL_VUS || 3),
      duration: DURATION,
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.001"],
    "http_req_duration{scenario:list}": ["p(95)<300"],
    "http_req_duration{scenario:dashboard_cached}": ["p(95)<100"],
    "http_req_duration{scenario:dashboard_cold}": ["p(95)<800"],
    "http_req_duration{scenario:pdf}": ["p(95)<1500"],
    "http_req_duration{scenario:excel}": ["p(95)<8000"],
  },
};

export function listInvoices() {
  const page = 1 + (__ITER % 3);
  const res = http.get(
    `${BASE}/api/sales/invoices?limit=20&page=${page}`,
    { headers: HEADERS, tags: { scenario: "list" } },
  );
  check(res, { "list 200": (r) => r.status === 200 });
}

export function dashboardCached() {
  const res = http.get(
    `${BASE}/api/dashboard/owner?startDate=2026-01-01T00:00:00.000Z&endDate=2026-11-12T23:59:59.999Z`,
    { headers: HEADERS, tags: { scenario: "dashboard_cached" } },
  );
  check(res, { "dashboard 200": (r) => r.status === 200 });
}

export function dashboardCold() {
  const res = http.get(`${BASE}/api/dashboard/owner?${rangeFor(__ITER)}`, {
    headers: HEADERS,
    tags: { scenario: "dashboard_cold" },
  });
  check(res, { "dashboard cold 200": (r) => r.status === 200 });
}

export function invoicePdf() {
  const res = http.get(`${BASE}/api/sales/invoices/${INVOICE_ID}/pdf`, {
    headers: HEADERS,
    tags: { scenario: "pdf" },
  });
  check(res, { "pdf 200": (r) => r.status === 200 });
}

export function salesExcel() {
  const res = http.get(
    `${BASE}/api/sales/report/excel?start_date=2026-01-01&end_date=2026-12-31`,
    { headers: HEADERS, tags: { scenario: "excel" } },
  );
  check(res, {
    "excel 200 or capped": (r) => r.status === 200 || r.status === 400,
  });
}
