import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import { generateSalesExcelBuffer } from "./invoiceGenerator.js";

const invoice = {
  invoice_number: "INV-1001",
  createdAt: new Date("2026-01-15T10:30:00Z"),
  total_meters: "12.5",
  total_amount: "250.75",
  branch: { name: "Salmiya" },
  creator: { full_name: "Ali" },
  customer: { full_name: "Sara", phone: "9655555", address: "Kuwait City" },
  payments: [{ method: "Cash", amount: "250.75" }],
};

const load = async (invoices) => {
  const buffer = await generateSalesExcelBuffer(invoices);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  return workbook;
};

test("generates a non-empty xlsx buffer", async () => {
  const buffer = await generateSalesExcelBuffer([invoice]);
  assert.ok(Buffer.isBuffer(buffer));
  assert.ok(buffer.length > 1000);
  assert.equal(buffer.subarray(0, 2).toString(), "PK");
});

test("names the worksheet in Arabic", async () => {
  const workbook = await load([invoice]);
  assert.equal(workbook.worksheets[0].name, "المبيعات");
});

test("writes the Arabic header row", async () => {
  const workbook = await load([invoice]);
  const sheet = workbook.worksheets[0];
  const headers = [];
  sheet.getRow(1).eachCell((cell) => headers.push(cell.value));
  assert.deepEqual(headers, [
    "التاريخ",
    "الوقت",
    "رقم الفاتورة",
    "الفرع",
    "البائع",
    "اسم العميل",
    "الهاتف",
    "العنوان",
    "إجمالي الأمتار (متر)",
    "المبلغ الإجمالي (د.ك)",
    "طريقة الدفع",
  ]);
});

test("fills the invoice row with three decimals", async () => {
  const workbook = await load([invoice]);
  const sheet = workbook.worksheets[0];
  const values = [];
  sheet.getRow(2).eachCell((cell) => values.push(cell.value));
  assert.equal(values[2], "INV-1001");
  assert.equal(values[3], "Salmiya");
  assert.equal(values[4], "Ali");
  assert.equal(values[8], "12.500");
  assert.equal(values[9], "250.750");
  assert.equal(values[10], "Cash:250.750");
});

test("falls back to defaults for missing relations", async () => {
  const workbook = await load([
    {
      invoice_number: "INV-2",
      createdAt: new Date("2026-02-01T08:00:00Z"),
      total_meters: 0,
      total_amount: 0,
    },
  ]);
  const values = [];
  workbook.worksheets[0].getRow(2).eachCell((cell) => values.push(cell.value));
  assert.equal(values[3], "Main");
  assert.equal(values[4], "Admin");
  assert.equal(values[5], "-");
  assert.equal(values[10], "Cash");
});

test("writes one row per invoice", async () => {
  const workbook = await load([invoice, { ...invoice, invoice_number: "INV-1002" }]);
  assert.equal(workbook.worksheets[0].rowCount, 3);
});

test("produces a header-only sheet for an empty list", async () => {
  const workbook = await load([]);
  assert.equal(workbook.worksheets[0].rowCount, 1);
});
