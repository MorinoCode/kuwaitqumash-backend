import ExcelJS from "exceljs";

// The report is handed to Kuwaiti customers, so its headers are always Arabic.
// A fabric shop sells by the metre, hence metres instead of the gold-shop grams.
const SALES_EXCEL_HEADERS = [
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
];

const SALES_EXCEL_SHEET_NAME = "المبيعات";

const SALES_EXCEL_KEYS = [
  { key: "date", width: 15 },
  { key: "time", width: 10 },
  { key: "inv", width: 25 },
  { key: "branch", width: 15 },
  { key: "seller", width: 20 },
  { key: "cust_name", width: 25 },
  { key: "phone", width: 15 },
  { key: "address", width: 25 },
  { key: "meters", width: 18 },
  { key: "amount", width: 18 },
  { key: "payment", width: 25 },
];

const buildSalesExcelColumns = () =>
  SALES_EXCEL_KEYS.map((col, i) => ({
    header: SALES_EXCEL_HEADERS[i],
    key: col.key,
    width: col.width,
  }));

const buildSalesExcelRow = (inv) => {
  const invDate = new Date(inv.createdAt);
  const pays = inv.payments || [];
  const paymentStr = pays.length
    ? pays
        .map((p) => `${p.method}:${parseFloat(p.amount).toFixed(3)}`)
        .join(" | ")
    : "Cash";

  return {
    date: invDate.toLocaleDateString(),
    time: invDate.toLocaleTimeString(),
    inv: inv.invoice_number,
    branch: (inv.branch && inv.branch.name) || "Main",
    seller: (inv.creator && inv.creator.full_name) || "Admin",
    cust_name: (inv.customer && inv.customer.full_name) || "-",
    phone: (inv.customer && inv.customer.phone) || "-",
    address: (inv.customer && inv.customer.address) || "-",
    meters: parseFloat(inv.total_meters).toFixed(3),
    amount: parseFloat(inv.total_amount).toFixed(3),
    payment: paymentStr,
  };
};

/**
 * Writes the sales report straight into the HTTP response in pages.
 * Rows are committed to a streaming workbook writer, so memory stays flat
 * instead of holding thousands of invoices plus a full xlsx buffer.
 */
export const streamSalesExcel = async ({
  res,
  filename,
  fetchPage,
  totalCount,
  pageSize = 1000,
}) => {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${filename}.xlsx"`,
  );

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: res,
    useStyles: false,
    useSharedStrings: false,
  });
  const worksheet = workbook.addWorksheet(SALES_EXCEL_SHEET_NAME);
  worksheet.columns = buildSalesExcelColumns();

  let written = 0;
  for (let offset = 0; offset < totalCount; offset += pageSize) {
    const invoices = await fetchPage(pageSize, offset);
    if (!invoices || invoices.length === 0) break;

    for (const inv of invoices) {
      worksheet.addRow(buildSalesExcelRow(inv)).commit();
      written += 1;
    }
  }

  worksheet.commit();
  await workbook.commit();
  return written;
};

export const generateSalesExcelBuffer = async (invoices) => {
  const workbook = new ExcelJS.Workbook();
  const worksheet = workbook.addWorksheet(SALES_EXCEL_SHEET_NAME);
  worksheet.columns = buildSalesExcelColumns();
  for (const inv of invoices) {
    const invDate = new Date(inv.createdAt);
    const pays = inv.payments || [];
    const paymentStr = pays.length
      ? pays
          .map((p) => `${p.method}:${parseFloat(p.amount).toFixed(3)}`)
          .join(" | ")
      : "Cash";
    const branchName = (inv.branch && inv.branch.name) || "Main";
    worksheet.addRow({
      date: invDate.toLocaleDateString(),
      time: invDate.toLocaleTimeString(),
      inv: inv.invoice_number,
      branch: branchName,
      seller: (inv.creator && inv.creator.full_name) || "Admin",
      cust_name: (inv.customer && inv.customer.full_name) || "-",
      phone: (inv.customer && inv.customer.phone) || "-",
      address: (inv.customer && inv.customer.address) || "-",
      meters: parseFloat(inv.total_meters).toFixed(3),
      amount: parseFloat(inv.total_amount).toFixed(3),
      payment: paymentStr,
    });
  }
  return await workbook.xlsx.writeBuffer();
};
