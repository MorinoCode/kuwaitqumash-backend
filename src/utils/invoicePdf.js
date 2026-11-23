import { jsPDF } from "jspdf";
import logger from "./logger.js";
import {
  safeNum,
  safeStr,
  formatDate,
  formatTime,
  getImageAsBase64,
  loadInvoiceFonts,
  label,
} from "./invoicePdfHelpers.js";
import {
  drawInvoiceHeaderSection,
  drawInvoiceFooterSection,
  fitLogoDimensions,
} from "./invoicePdfSections.js";

export const generateInvoicePDF = async (
  invoice,
  items,
  customer,
  user,
  branchName,
  storeSettings = {},
  branchLogoUrl = null
) => {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a5" });
  const fonts = loadInvoiceFonts(doc);

  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();

  const brand = [0, 0, 0];
  const brandDark = [0, 0, 0];
  const brandLight = [245, 245, 245];

  const m = 5;
  const bottomMargin = 6;
  const maxY = pageH - bottomMargin;
  let y = m;

  let logoBase64 = null;
  let logoBase64Watermark = null;
  if (branchLogoUrl) {
    try {
      logoBase64 = await getImageAsBase64(branchLogoUrl, true, 1.0);
      logoBase64Watermark = await getImageAsBase64(branchLogoUrl, true, 0.2);
    } catch (error) {
      logger.warn("Failed to load branch logo", {
        component: "invoiceGenerator",
        error: error?.message,
      });
    }
  }

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

  const checkPageBreak = (requiredHeight) => {
    if (y + requiredHeight > maxY) {
      doc.addPage();
      y = m;

      doc.setDrawColor(...brandDark);
      doc.setLineWidth(1);
      doc.rect(2, 2, pageW - 4, pageH - 4);

      if (logoBase64Watermark) {
        try {
          const { width: wmW, height: wmH } = fitLogoDimensions(
            doc,
            logoBase64Watermark,
            55,
            55
          );
          const watermarkX = (pageW - wmW) / 2;
          const watermarkY = (pageH - wmH) / 2;
          doc.addImage(
            logoBase64Watermark,
            "PNG",
            watermarkX,
            watermarkY,
            wmW,
            wmH,
            undefined,
            "FAST"
          );
        } catch (error) {
          logger.warn("Failed to add logo watermark on new page", {
            component: "invoiceGenerator",
            error: error?.message,
          });
        }
      }
      return true;
    }
    return false;
  };

  y = drawInvoiceHeaderSection({
    doc,
    pageW,
    pageH,
    m,
    y,
    brand,
    brandDark,
    branchName,
    storeSettings,
    invoice,
    logoBase64,
    logoBase64Watermark,
    setArFont,
    setFont,
  });

  const boxWidth = (pageW - 2 * m - 4) / 2;
  const boxHeaderHeight = 3.5;
  const fieldSpacing = 3.2;
  const labelFontSize = 5.5;
  const valueFontSize = 5.5;
  const padding = 1.0;

  let customerBoxY = y + boxHeaderHeight + 0.8;
  let invoiceBoxY = y + boxHeaderHeight + 0.8;

  const nameValue = safeStr(customer?.full_name, "-");
  const nameLabel = label("name", true);
  const nameText = `${nameLabel}: ${nameValue}`;
  const nameLines = doc.splitTextToSize(nameText, boxWidth - padding * 2 - 2);
  customerBoxY += fieldSpacing + (nameLines.length - 1) * 3.0;
  customerBoxY += fieldSpacing;
  const addressValue = safeStr(customer?.address, "-");
  const addressText = `${label("address", true)}: ${addressValue}`;
  const addressLines = doc.splitTextToSize(
    addressText,
    boxWidth - padding * 2 - 2
  );
  customerBoxY += fieldSpacing + (addressLines.length - 1) * 3.0;
  customerBoxY += fieldSpacing;
  const customerBoxHeight = customerBoxY - y + 0.8;

  invoiceBoxY += fieldSpacing;
  invoiceBoxY += fieldSpacing;
  const salesmanValue = safeStr(user?.full_name, "Admin");
  const salesmanLabel = label("salesman", true);
  const salesmanText = `${salesmanLabel}: ${salesmanValue}`;
  const salesmanLines = doc.splitTextToSize(
    salesmanText,
    boxWidth - padding * 2 - 2
  );
  invoiceBoxY += fieldSpacing + (salesmanLines.length - 1) * 3.0;
  const paymentMethodsStr =
    Array.isArray(invoice.payments) && invoice.payments.length > 0
      ? invoice.payments
          .map((p) => {
            const amount = safeNum(p.amount, 0).toFixed(3);
            const ref = p.reference_number || p.reference || "";
            return ref
              ? `${p.method || "Cash"}: ${amount} (Ref: ${ref})`
              : `${p.method || "Cash"}: ${amount}`;
          })
          .join(", ")
      : "Cash";
  const paymentLabelCalc = label("payment", true);
  const paymentTextCalc = `${paymentLabelCalc}: ${paymentMethodsStr}`;
  const paymentLines = doc.splitTextToSize(
    paymentTextCalc,
    boxWidth - padding * 2 - 2
  );
  invoiceBoxY += fieldSpacing + (paymentLines.length - 1) * 3.0;
  const invoiceBoxHeight = invoiceBoxY - y + 0.8;

  const maxBoxHeight = Math.max(customerBoxHeight, invoiceBoxHeight);

  doc.setDrawColor(...brandDark);
  doc.setLineWidth(0.25);
  doc.rect(m, y, boxWidth, maxBoxHeight);
  doc.setFillColor(...brandLight);
  doc.rect(m + 0.3, y + 0.3, boxWidth - 0.6, maxBoxHeight - 0.6, "F");

  doc.setFillColor(255, 255, 255);
  doc.rect(m + 0.3, y + 0.3, boxWidth - 0.6, boxHeaderHeight, "F");
  doc.setDrawColor(...brandDark);
  doc.setLineWidth(0.25);
  doc.line(m, y + boxHeaderHeight + 0.3, m + boxWidth, y + boxHeaderHeight + 0.3);
  setArFont(true);
  doc.setFontSize(6.0);
  doc.setTextColor(0, 0, 0);
  doc.text(
    label("customerDetails", true),
    m + boxWidth / 2,
    y + boxHeaderHeight / 2 + 0.8,
    { align: "center" }
  );

  let currentY = y + boxHeaderHeight + 1.2 + 1.0;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(valueFontSize);

  setArabicFont();
  doc.setFontSize(labelFontSize);
  const nameTextDisplay = `${label("name", true)}: ${nameValue}`;
  const nameLinesDisplay = doc.splitTextToSize(
    nameTextDisplay,
    boxWidth - padding * 2 - 1
  );
  nameLinesDisplay.forEach((line, idx) => {
    doc.text(line, m + padding, currentY + idx * 3.0, {
      maxWidth: boxWidth - padding * 2 - 1,
    });
  });
  currentY += fieldSpacing + (nameLinesDisplay.length - 1) * 3.0;

  setArabicFont();
  doc.setFontSize(labelFontSize);
  const phoneValue = safeStr(customer?.phone, "-");
  doc.text(`${label("phone", true)}: ${phoneValue}`, m + padding, currentY);
  currentY += fieldSpacing;

  setArabicFont();
  doc.setFontSize(labelFontSize);
  const addressTextDisplay = `${label("address", true)}: ${addressValue}`;
  const addressLinesDisplay = doc.splitTextToSize(
    addressTextDisplay,
    boxWidth - padding * 2 - 1
  );
  addressLinesDisplay.forEach((line, idx) => {
    doc.text(line, m + padding, currentY + idx * 3.0, {
      maxWidth: boxWidth - padding * 2 - 1,
    });
  });
  currentY += fieldSpacing + (addressLinesDisplay.length - 1) * 3.0;

  setArabicFont();
  doc.setFontSize(labelFontSize);
  doc.text(
    `${label("customerType", true)}: ${safeStr(customer?.type, "Regular")}`,
    m + padding,
    currentY
  );

  const invoiceBoxX = m + boxWidth + 4;
  doc.setDrawColor(...brandDark);
  doc.setLineWidth(0.25);
  doc.rect(invoiceBoxX, y, boxWidth, maxBoxHeight);
  doc.setFillColor(...brandLight);
  doc.rect(invoiceBoxX + 0.3, y + 0.3, boxWidth - 0.6, maxBoxHeight - 0.6, "F");

  doc.setFillColor(255, 255, 255);
  doc.rect(invoiceBoxX + 0.3, y + 0.3, boxWidth - 0.6, boxHeaderHeight, "F");
  doc.setDrawColor(...brandDark);
  doc.setLineWidth(0.25);
  doc.line(invoiceBoxX, y + boxHeaderHeight + 0.3, invoiceBoxX + boxWidth, y + boxHeaderHeight + 0.3);
  setArFont(true);
  doc.setFontSize(6.0);
  doc.setTextColor(0, 0, 0);
  doc.text(
    label("invoiceDetails", true),
    invoiceBoxX + boxWidth / 2,
    y + boxHeaderHeight / 2 + 0.8,
    { align: "center" }
  );

  currentY = y + boxHeaderHeight + 1.2 + 1.0;
  doc.setTextColor(0, 0, 0);
  doc.setFontSize(valueFontSize);

  setArabicFont();
  doc.setFontSize(labelFontSize);
  doc.text(
    `${label("date", true)}: ${formatDate(invoice)}`,
    invoiceBoxX + padding,
    currentY
  );
  currentY += fieldSpacing;

  setArabicFont();
  doc.setFontSize(labelFontSize);
  doc.text(
    `${label("time", true)}: ${formatTime(invoice)}`,
    invoiceBoxX + padding,
    currentY
  );
  currentY += fieldSpacing;

  setArabicFont();
  doc.setFontSize(labelFontSize);
  const salesmanTextDisplay = `${label("salesman", true)}: ${salesmanValue}`;
  const salesmanLinesDisplay = doc.splitTextToSize(
    salesmanTextDisplay,
    boxWidth - padding * 2 - 1
  );
  salesmanLinesDisplay.forEach((line, idx) => {
    doc.text(line, invoiceBoxX + padding, currentY + idx * 3.0, {
      maxWidth: boxWidth - padding * 2 - 1,
    });
  });
  currentY += fieldSpacing + (salesmanLinesDisplay.length - 1) * 3.0;

  setArabicFont();
  doc.setFontSize(labelFontSize);
  const paymentTextDisplay = `${label("payment", true)}: ${paymentMethodsStr}`;
  const paymentLinesDisplay = doc.splitTextToSize(
    paymentTextDisplay,
    boxWidth - padding * 2 - 1
  );
  paymentLinesDisplay.forEach((line, idx) => {
    doc.text(line, invoiceBoxX + padding, currentY + idx * 3.0, {
      maxWidth: boxWidth - padding * 2 - 1,
    });
  });

  y += maxBoxHeight + 1.5;

  const itemsList = Array.isArray(items) ? items : [];

  const tableWidth = pageW - 2 * m;
  const colWidths = [
    tableWidth * 0.04,
    tableWidth * 0.2,
    tableWidth * 0.16,
    tableWidth * 0.13,
    tableWidth * 0.07,
    tableWidth * 0.06,
    tableWidth * 0.1,
    tableWidth * 0.09,
    tableWidth * 0.15,
  ];

  const rowHeight = 3.8;
  const tableHeaderHeight = 4.5;
  const tableStartX = m;
  const tableStartY = y;

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...brandDark);
  doc.rect(tableStartX, tableStartY, tableWidth, tableHeaderHeight, "FD");

  doc.setFontSize(5.0);
  doc.setTextColor(0, 0, 0);

  let headerX = tableStartX + 0.5;
  const headerLabelsAr = [
    "#",
    "Item / الصنف",
    "Code / الكود",
    "Fabric / القماش",
    "Meters / الأمتار",
    "Qty / الكمية",
    "Price/m",
    "Disc / الخصم",
    "Total / الإجمالي",
  ];

  headerLabelsAr.forEach((labelAr, idx) => {
    const width = colWidths[idx];
    const align =
      idx === 0 || idx === 2 || idx === 3 || idx === 5
        ? "center"
        : idx === 1
        ? "left"
        : "right";
    let textX;
    if (align === "center") {
      textX = headerX + width / 2;
    } else if (align === "right") {
      textX = headerX + width - 0.5;
    } else {
      textX = headerX + 0.5;
    }

    setArFont(true);
    doc.text(labelAr, textX, tableStartY + tableHeaderHeight / 2 + 1.0, { align });
    headerX += width;
  });

  y = tableStartY + tableHeaderHeight;
  doc.setTextColor(0, 0, 0);
  setFont(false);

  itemsList.forEach((item, idx) => {
    if (checkPageBreak(rowHeight + 1.5)) {
      doc.setFillColor(255, 255, 255);
      doc.setDrawColor(...brandDark);
      doc.rect(tableStartX, y, tableWidth, tableHeaderHeight, "FD");
      doc.setFontSize(5.0);
      doc.setTextColor(0, 0, 0);

      let headerX2 = tableStartX + 0.5;
      headerLabelsAr.forEach((labelAr, lIdx) => {
        const width = colWidths[lIdx];
        const align =
          lIdx === 0 || lIdx === 2 || lIdx === 3 || lIdx === 5
            ? "center"
            : lIdx === 1
            ? "left"
            : "right";
        let textX;
        if (align === "center") {
          textX = headerX2 + width / 2;
        } else if (align === "right") {
          textX = headerX2 + width - 0.5;
        } else {
          textX = headerX2 + 0.5;
        }

        setArFont(true);
        doc.text(labelAr, textX, y + tableHeaderHeight / 2 + 1.0, { align });
        headerX2 += width;
      });
      y += tableHeaderHeight;
      doc.setTextColor(0, 0, 0);
      setFont(false);
    }
    const inventoryItem = item.inventoryItem || {};
    const itemCode = safeStr(
      item.barcode || inventoryItem.barcode || inventoryItem.rfid_tag || "",
      "-"
    );
    const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);
    const itemMeters = safeNum(item.meters, 0);
    const itemDiscount = safeNum(item.discount, 0);
    const itemPrice = safeNum(item.total_price, 0);
    const totalMetersForRow = itemMeters * quantity;
    const pricePerMeter =
      item.price_per_meter != null && item.price_per_meter !== ""
        ? safeNum(item.price_per_meter, 0).toFixed(3)
        : totalMetersForRow > 0 && itemPrice >= 0
        ? (itemPrice / totalMetersForRow).toFixed(3)
        : "0.000";

    if (idx % 2 === 1) {
      doc.setFillColor(...brandLight);
      doc.rect(tableStartX, y, tableWidth, rowHeight, "F");
    }

    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.2);
    doc.line(tableStartX, y, tableStartX + tableWidth, y);

    let cellX = tableStartX + 0.5;
    const rowData = [
      { text: String(idx + 1), align: "center", font: false },
      { text: safeStr(item.item_name, "-"), align: "left", font: false },
      { text: itemCode, align: "center", font: false },
      {
        text: safeStr(item.fabric_type, "-"),
        align: "center",
        font: false,
      },
      { text: (itemMeters || 0).toFixed(2), align: "right", font: false },
      { text: String(quantity), align: "center", font: false },
      { text: pricePerMeter, align: "right", font: false },
      { text: itemDiscount.toFixed(3), align: "right", font: false },
      { text: (itemPrice || 0).toFixed(3), align: "right", font: true },
    ];

    const barcodeColIdx = 2;
    rowData.forEach((cell, cIdx) => {
      const width = colWidths[cIdx];
      doc.setFontSize(cIdx === 8 ? 6.0 : cIdx === barcodeColIdx ? 5.0 : 5.5);
      setMixedFont(cell.text, cell.font);

      let textX;
      if (cell.align === "center") {
        textX = cellX + width / 2;
      } else if (cell.align === "right") {
        textX = cellX + width - 0.5;
      } else {
        textX = cellX + 0.5;
      }

      const cellText = String(cell.text);
      const wrapped =
        cIdx === barcodeColIdx
          ? [cellText]
          : doc.splitTextToSize(cellText, width - 1);

      wrapped.forEach((line, lineIdx) => {
        doc.text(line, textX, y + rowHeight / 2 + 0.6 + lineIdx * 2.5, {
          align: cell.align,
          maxWidth: cIdx === barcodeColIdx ? undefined : width - 1,
        });
      });

      if (wrapped.length > 1 && cIdx === 0) {
        y += (wrapped.length - 1) * 2.5;
      }

      cellX += width;
    });

    y += rowHeight;
  });

  doc.setDrawColor(...brandDark);
  doc.setLineWidth(0.4);
  doc.line(tableStartX, y, tableStartX + tableWidth, y);
  y += 1.5;

  checkPageBreak(8);

  checkPageBreak(8);

  doc.setDrawColor(...brand);
  doc.setLineWidth(0.4);
  doc.line(m, y, pageW - m, y);
  y += 4.0;

  setArabicFont();
  doc.setFontSize(6.0);
  doc.setTextColor(60, 60, 60);
  doc.text(`${label("totalMeters", true)}:`, m, y);
  doc.setTextColor(0, 0, 0);
  setFont(true);
  const totalMetersText = `${safeNum(invoice.total_meters, 0).toFixed(2)} m`;
  doc.text(totalMetersText, pageW - m - 2, y, { align: "right" });
  y += 4.5;

  setArabicFont();
  doc.setTextColor(60, 60, 60);
  doc.text(`${label("grandTotal", true)}:`, m, y);
  doc.setTextColor(0, 0, 0);
  setFont(true);
  doc.text(
    `${safeNum(invoice.total_amount, 0).toFixed(3)} KWD`,
    pageW - m - 2,
    y,
    { align: "right" }
  );
  y += 4.5;

  const paymentsList =
    Array.isArray(invoice.payments) && invoice.payments.length > 0
      ? invoice.payments
      : [{ method: "Cash", amount: safeNum(invoice.total_amount, 0) }];
  const totalPaid = paymentsList.reduce(
    (sum, p) => sum + safeNum(p.amount, 0),
    0
  );
  const remainingAmount = safeNum(invoice.total_amount, 0) - totalPaid;

  const paymentHeaderHeight = 4.0;
  const rowSpacing = 3.2;
  let paymentSectionHeight = paymentHeaderHeight + 2.5;

  paymentsList.forEach((p) => {
    const methodText = `${safeStr(p.method, "Cash")}:`;
    const amountText = `${safeNum(p.amount, 0).toFixed(3)} KWD`;
    const methodLines = doc.splitTextToSize(
      methodText,
      (pageW - 2 * m - 6) / 2
    );
    const amountLines = doc.splitTextToSize(
      amountText,
      (pageW - 2 * m - 6) / 2
    );
    paymentSectionHeight +=
      Math.max(methodLines.length, amountLines.length) * rowSpacing;
  });

  paymentSectionHeight += 1.2;
  paymentSectionHeight += rowSpacing;

  if (remainingAmount > 0.001) {
    const remainingLabel = `${label("remainingAmount", true)}:`;
    const remainingValue = `${remainingAmount.toFixed(3)} KWD`;
    const remainingLabelLines = doc.splitTextToSize(
      remainingLabel,
      (pageW - 2 * m - 6) / 2
    );
    const remainingValueLines = doc.splitTextToSize(
      remainingValue,
      (pageW - 2 * m - 6) / 2
    );
    paymentSectionHeight +=
      Math.max(remainingLabelLines.length, remainingValueLines.length) *
      rowSpacing;
  }

  checkPageBreak(paymentSectionHeight + 2);

  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...brand);
  doc.setLineWidth(0.25);
  doc.rect(m, y - 0.5, pageW - 2 * m, paymentSectionHeight, "FD");

  doc.setDrawColor(...brandDark);
  doc.setLineWidth(0.25);
  doc.line(m, y + paymentHeaderHeight, pageW - m, y + paymentHeaderHeight);

  setArFont(true);
  doc.setFontSize(6.5);
  doc.setTextColor(0, 0, 0);
  doc.text(
    label("paymentMethod", true),
    pageW / 2,
    y + paymentHeaderHeight / 2 + 0.8,
    { align: "center" }
  );

  let paymentY = y + paymentHeaderHeight + 2.5;
  setFont(false);
  doc.setFontSize(6.0);
  doc.setTextColor(0, 0, 0);

  paymentsList.forEach((p) => {
    const methodText = `${safeStr(p.method, "Cash")}:`;
    const paymentAmount = safeNum(p.amount, 0) || 0;
    const amountText = `${paymentAmount.toFixed(3)} KWD`;

    const methodLines = doc.splitTextToSize(
      methodText,
      (pageW - 2 * m - 6) / 2
    );
    const amountLines = doc.splitTextToSize(
      amountText,
      (pageW - 2 * m - 6) / 2
    );
    const maxLines = Math.max(methodLines.length, amountLines.length);

    methodLines.forEach((line, idx) => {
      doc.text(line, m + 2, paymentY + idx * rowSpacing, {
        maxWidth: (pageW - 2 * m - 6) / 2,
      });
    });
    amountLines.forEach((line, idx) => {
      doc.text(line, pageW - m - 2, paymentY + idx * rowSpacing, {
        align: "right",
        maxWidth: (pageW - 2 * m - 6) / 2,
      });
    });

    paymentY += maxLines * rowSpacing;
  });

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.2);
  doc.line(m + 1.5, paymentY - 0.5, pageW - m - 1.5, paymentY - 0.5);
  paymentY += 2.5;

  setArabicFont();
  doc.setFontSize(6.5);
  const totalPaidLabel = `${label("totalPaid", true)}:`;
  const totalPaidValue = totalPaid || 0;
  const totalPaidValueText = `${totalPaidValue.toFixed(3)} KWD`;
  const totalPaidLabelLines = doc.splitTextToSize(
    totalPaidLabel,
    (pageW - 2 * m - 6) / 2
  );
  const totalPaidValueLines = doc.splitTextToSize(
    totalPaidValueText,
    (pageW - 2 * m - 6) / 2
  );
  const totalPaidMaxLines = Math.max(
    totalPaidLabelLines.length,
    totalPaidValueLines.length
  );

  totalPaidLabelLines.forEach((line, idx) => {
    doc.text(line, m + 2, paymentY + idx * rowSpacing, {
      maxWidth: (pageW - 2 * m - 6) / 2,
    });
  });
  totalPaidValueLines.forEach((line, idx) => {
    doc.text(line, pageW - m - 2, paymentY + idx * rowSpacing, {
      align: "right",
      maxWidth: (pageW - 2 * m - 6) / 2,
    });
  });
  paymentY += totalPaidMaxLines * rowSpacing;

  if (remainingAmount > 0.001) {
    setArabicFont();
    doc.setFontSize(6.5);
    const remainingLabel = `${label("remainingAmount", true)}:`;
    const remainingValue = remainingAmount || 0;
    const remainingValueText = `${remainingValue.toFixed(3)} KWD`;
    const remainingLabelLines = doc.splitTextToSize(
      remainingLabel,
      (pageW - 2 * m - 6) / 2
    );
    const remainingValueLines = doc.splitTextToSize(
      remainingValueText,
      (pageW - 2 * m - 6) / 2
    );
    const remainingMaxLines = Math.max(
      remainingLabelLines.length,
      remainingValueLines.length
    );

    remainingLabelLines.forEach((line, idx) => {
      doc.text(line, m + 2, paymentY + idx * rowSpacing, {
        maxWidth: (pageW - 2 * m - 6) / 2,
      });
    });
    remainingValueLines.forEach((line, idx) => {
      doc.text(line, pageW - m - 2, paymentY + idx * rowSpacing, {
        align: "right",
        maxWidth: (pageW - 2 * m - 6) / 2,
      });
    });
    paymentY += remainingMaxLines * rowSpacing;
  }

  doc.setTextColor(0, 0, 0);
  y = paymentY + 1.5;

  checkPageBreak(7);

  y = drawInvoiceFooterSection({
    doc,
    pageW,
    m,
    y,
    brand,
    brandDark,
    invoice,
    user,
    storeSettings,
    setArFont,
    setArabicFont,
    ensurePageSpace: (requiredHeight, currentPosY) => {
      y = currentPosY;
      checkPageBreak(requiredHeight);
      return y;
    },
  });
  const buffer = Buffer.from(doc.output("arraybuffer"));
  return { buffer };
};

export const generateInvoicePDFAsBuffer = generateInvoicePDF;

