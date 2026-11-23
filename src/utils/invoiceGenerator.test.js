import test from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import sharp from "sharp";
import {
  generateInvoicePDF,
  generateSalesExcelBuffer,
} from "./invoiceGenerator.js";
import { getImageAsBase64 } from "./invoicePdfHelpers.js";
import {
  deleteImage,
  deleteStoreFolder,
  saveBranchLogo,
} from "./fileUpload.js";

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

test("generateInvoicePDF embeds local branch logo with watermark and omits removed terms/KYC sections", async () => {
  const sampleLogo = await sharp({
    create: {
      width: 240,
      height: 120,
      channels: 4,
      background: { r: 13, g: 148, b: 136, alpha: 1 },
    },
  })
    .webp()
    .toBuffer();

  const saved = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  };
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_NAME;
  delete process.env.R2_PUBLIC_URL;

  let logoUrl = null;
  try {
    logoUrl = await saveBranchLogo({ buffer: sampleLogo }, "pdf-logo-test", 7);
    assert.ok(logoUrl && logoUrl.startsWith("/uploads/"));

    const fullB64 = await getImageAsBase64(logoUrl, true, 1.0);
    const wmB64 = await getImageAsBase64(logoUrl, true, 0.2);
    assert.ok(fullB64?.startsWith("data:image/png;base64,"));
    assert.ok(wmB64?.startsWith("data:image/png;base64,"));
    assert.notEqual(fullB64, wmB64);

    const sampleItems = [
      {
        item_name: "Silk Fabric",
        fabric_type: "Silk",
        barcode: "BC-101",
        meters: 3.5,
        quantity: 1,
        price_per_meter: 10,
        discount: 0,
        total_price: 35,
      },
    ];

    const pdfWithoutLogo = await generateInvoicePDF(
      invoice,
      sampleItems,
      invoice.customer,
      invoice.creator,
      "Salmiya",
      { name: "Qummash", phone: "96550001111" },
      null,
    );
    const pdfWithLogo = await generateInvoicePDF(
      invoice,
      sampleItems,
      invoice.customer,
      invoice.creator,
      "Salmiya",
      { name: "Qummash", phone: "96550001111" },
      logoUrl,
    );

    assert.ok(Buffer.isBuffer(pdfWithLogo.buffer));
    assert.equal(pdfWithLogo.buffer.subarray(0, 4).toString(), "%PDF");
    assert.ok(
      pdfWithLogo.buffer.length > pdfWithoutLogo.buffer.length,
      "PDF with logo should embed logo image streams",
    );
    const pdfRaw = pdfWithLogo.buffer.toString("latin1");
    assert.ok(pdfRaw.includes("/Subtype /Image"), "PDF must include embedded image XObject");
  } finally {
    if (logoUrl) {
      await deleteImage(logoUrl);
    }
    await deleteStoreFolder("pdf-logo-test");
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
