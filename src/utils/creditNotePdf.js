import { jsPDF } from "jspdf";
import {
  safeStr,
  formatDate,
  formatTime,
  getImageAsBase64,
  loadInvoiceFonts,
  label,
} from "./invoicePdfHelpers.js";

export const generateCreditNotePDF = async (
  refund,
  invoice,
  customer,
  user,
  branchName,
  branchLogoUrl = null,
  branchInfo = {}
) => {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a5" });
  const fonts = loadInvoiceFonts(doc);

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const brand = [0, 0, 0];
  const brandDark = [0, 0, 0];
  const m = 8;

  const setArFont = (bold = false) => {
    if (fonts.hasAmiri) {
      doc.setFont("Amiri", bold && fonts.hasAmiriBold ? "bold" : "normal");
    } else if (fonts.hasCairo) {
      doc.setFont("Cairo", bold && fonts.hasCairoBold ? "bold" : "normal");
    } else {
      doc.setFont("helvetica", bold ? "bold" : "normal");
    }
  };

  const setMixedFont = (text, bold = false) => {
    if (fonts.hasAmiri) {
      doc.setFont("Amiri", bold && fonts.hasAmiriBold ? "bold" : "normal");
    } else if (fonts.hasCairo) {
      doc.setFont("Cairo", bold && fonts.hasCairoBold ? "bold" : "normal");
    } else {
      doc.setFont("helvetica", bold ? "bold" : "normal");
    }
  };

  const setArabicFont = () => setArFont(false);
  const setFont = (bold = false) => setArFont(bold);

  doc.setDrawColor(...brandDark);
  doc.rect(2, 2, pageW - 4, pageH - 4);

  let y = m;

  const maxY = pageH - 8;
  const checkPageBreak = (requiredHeight) => {
    if (y + requiredHeight > maxY) {
      doc.addPage();
      y = m;
      doc.setDrawColor(...brandDark);
      doc.rect(2, 2, pageW - 4, pageH - 4);
      return true;
    }
    return false;
  };

  if (branchLogoUrl) {
    try {
      const logoBase64 = await getImageAsBase64(branchLogoUrl, true, 1.0);
      const logoSize = 14;
      const logoX = (pageW - logoSize) / 2;
      doc.addImage(
        logoBase64,
        "PNG",
        logoX,
        y,
        logoSize,
        logoSize,
        undefined,
        "FAST"
      );
      y += 20;
    } catch (e) {
      void e;
      y += 5;
    }
  }

  const headerHeight = 12;
  doc.setFillColor(...brand);
  doc.rect(m, y, pageW - 2 * m, headerHeight, "F");
  doc.setTextColor(255, 255, 255);

  const displayBrand = branchInfo?.storeName || branchName;
  if (displayBrand && displayBrand !== "Branch") {
    doc.setFontSize(9);
    setArFont(true);
    doc.text(displayBrand, m + 3, y + 7.5);
  }

  doc.setFontSize(11);
  setArFont(true);
  doc.text(label("creditNote", true), pageW / 2, y + 7.5, {
    align: "center",
  });
  doc.setFontSize(10);
  const cnNum = safeStr(
    refund.credit_note_number || refund.refund_number,
    "N/A"
  );
  doc.text(`#${cnNum}`, pageW - m - 3, y + 7.5, { align: "right" });
  doc.setTextColor(0, 0, 0);
  y += headerHeight + 4;

  setArFont(false);
  doc.setFontSize(8);
  doc.setTextColor(90, 90, 90);
  doc.text(
    "Refund document for the original invoice. Certifies items and amounts returned.",
    m,
    y
  );
  y += 4.5;
  doc.text(
    "وثيقة مرتجع للفاتورة الأصلية. يثبت الأصناف والمبالغ المرتجعة.",
    m,
    y
  );
  y += 6.5;

  doc.setTextColor(0, 0, 0);
  doc.setFontSize(10);
  setArFont(true);
  doc.text(
    `${label("originalInvoice", true)}: ${safeStr(
      invoice?.invoice_number,
      "-"
    )}`,
    m,
    y
  );
  y += 5;
  doc.text(`${label("date", true)}: ${formatDate(refund)}`, m, y);
  doc.text(`${label("time", true)}: ${formatTime(refund)}`, pageW / 2, y);
  y += 6;

  doc.setFillColor(248, 248, 248);
  doc.rect(m, y, pageW - 2 * m, 24, "F");
  setArabicFont();
  doc.setFontSize(9);
  doc.text(
    `${label("name", true)}: ${safeStr(customer?.full_name, "-")}`,
    m + 2,
    y + 5
  );
  doc.text(
    `${label("phone", true)}: ${safeStr(customer?.phone, "-")}`,
    m + 2,
    y + 10
  );
  doc.text(
    `${label("address", true)}: ${safeStr(customer?.address, "-")}`,
    m + 2,
    y + 15,
    { maxWidth: pageW - 2 * m - 4 }
  );
  y += 28;

  doc.setDrawColor(...brand);
  doc.setLineWidth(0.5);
  doc.line(m, y, pageW - m, y);
  y += 5;

  const items = refund.items || [];
  doc.setFontSize(9);
  setArFont(true);
  doc.text(label("item", true), m, y);
  doc.text("Qty / الكمية", pageW - m - 45, y);
  doc.text("Amount / المبلغ", pageW - m - 3, y, { align: "right" });
  y += 5;

  doc.setLineWidth(0.2);
  doc.setDrawColor(200, 200, 200);
  doc.line(m, y, pageW - m, y);
  y += 4;

  setFont(false);
  for (const ri of items) {
    const invItem = ri.invoice_item || ri;
    const itemName = safeStr(invItem?.item_name, "-");
    const fabric_type = invItem?.fabric_type ? ` ${invItem.fabric_type}` : "";
    const meters = invItem?.meters
      ? ` (${parseFloat(invItem.meters).toFixed(2)} m)`
      : "";
    const desc = `${itemName}${fabric_type}${meters}`;
    const qty = ri.quantity_refunded || 0;
    const amt = parseFloat(ri.amount_refunded || 0).toFixed(3);

    const lines = doc.splitTextToSize(desc, pageW - 2 * m - 55);
    doc.setFontSize(9);
    setMixedFont(desc, false);
    doc.text(lines, m, y + 3);
    doc.text(String(qty), pageW - m - 45, y + 3);
    doc.text(`${amt} KWD`, pageW - m - 3, y + 3, { align: "right" });
    y += Math.max(10, lines.length * 5) + 3;
  }

  y += 4;
  doc.setDrawColor(...brand);
  doc.setLineWidth(0.5);
  doc.line(m, y, pageW - m, y);
  y += 6;

  setArFont(true);
  doc.setFontSize(10.5);
  doc.setTextColor(0, 0, 0);
  doc.text(label("refundAmount", true), m, y);
  const total = parseFloat(refund.total_amount || 0).toFixed(3);
  doc.text(`${total} KWD`, pageW - m - 3, y, { align: "right" });
  y += 8;

  const payments = refund.payments || [];
  if (payments.length > 0) {
    setArFont(false);
    doc.setFontSize(8.5);
    doc.setTextColor(40, 40, 40);
    const paymentLabel = label("paymentMethod", true);
    const paymentValues = payments
      .map((p) => `${p.method}: ${parseFloat(p.amount).toFixed(3)} KWD`)
      .join(" | ");
    doc.text(`${paymentLabel}: ${paymentValues}`, m, y);
    y += 6;
  }

  const creatorName = user?.full_name || "Staff";
  setArFont(false);
  doc.setFontSize(8.5);
  doc.setTextColor(40, 40, 40);
  doc.text(`${label("salesman", true)}: ${creatorName}`, m, y);
  y += 12;

  setArFont(true);
  doc.setFontSize(9);
  doc.setTextColor(0, 0, 0);
  doc.text(label("sellerSig", true), m + 8, y);
  doc.text(label("customerSig", true), pageW - m - 8, y, { align: "right" });
  doc.setDrawColor(...brand);
  doc.setLineWidth(0.5);
  doc.line(m + 8, y + 3, m + 50, y + 3);
  doc.line(pageW - m - 50, y + 3, pageW - m - 8, y + 3);
  y += 14;

  const branchLoc = branchInfo?.location;
  const branchPh = branchInfo?.phone;
  if (branchLoc || branchPh) {
    checkPageBreak(8);
    y += 1.5;
    doc.setDrawColor(...brand);
    doc.setLineWidth(0.3);
    doc.line(m, y, pageW - m, y);
    y += 3.5;

    setArabicFont();
    doc.setFontSize(5.5);
    doc.setTextColor(100, 100, 100);

    const parts = [];
    if (branchLoc) {
      parts.push(`${label("location", true)}: ${branchLoc}`);
    }
    if (branchPh) {
      parts.push(`${label("phone", true)}: ${branchPh}`);
    }
    const branchInfoText = parts.join(" | ");

    doc.text(branchInfoText, pageW / 2, y, { align: "center" });
  }

  const buffer = Buffer.from(doc.output("arraybuffer"));
  return { buffer };
};

