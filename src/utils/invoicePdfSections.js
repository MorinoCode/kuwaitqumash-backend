import logger from "./logger.js";
import {
  safeNum,
  safeStr,
  formatDate,
  formatTime,
  label,
} from "./invoicePdfHelpers.js";

export const fitLogoDimensions = (doc, base64, maxW, maxH) => {
  try {
    const props = doc.getImageProperties(base64);
    if (props?.width > 0 && props?.height > 0) {
      const ratio = props.width / props.height;
      let width = maxW;
      let height = width / ratio;
      if (height > maxH) {
        height = maxH;
        width = height * ratio;
      }
      return { width, height };
    }
  } catch {
    // Fallback to square dimensions when metadata cannot be parsed
  }
  const size = Math.min(maxW, maxH);
  return { width: size, height: size };
};

export const drawInvoiceHeaderSection = ({
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
}) => {
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
      logger.warn("Failed to add logo watermark", {
        component: "invoiceGenerator",
        error: error?.message,
      });
      if (branchName) {
        doc.saveGraphicsState();
        doc.setTextColor(248, 248, 248);
        doc.setFontSize(50);
        setFont(true);
        const watermarkText = String(branchName).toUpperCase();
        const textWidth = doc.getStringUnitWidth(watermarkText) * 50;
        const watermarkX = safeNum((pageW - textWidth) / 2, 50);
        const watermarkY = safeNum(pageH * 0.5, 105);
        doc.text(watermarkText, watermarkX + textWidth / 2, watermarkY, {
          angle: 45,
          align: "center",
        });
        doc.restoreGraphicsState();
      }
    }
  } else if (branchName) {
    doc.saveGraphicsState();
    doc.setTextColor(248, 248, 248);
    doc.setFontSize(50);
    setFont(true);
    const watermarkText = String(branchName).toUpperCase();
    const textWidth = doc.getStringUnitWidth(watermarkText) * 50;
    const watermarkX = safeNum((pageW - textWidth) / 2, 50);
    const watermarkY = safeNum(pageH * 0.5, 105);
    doc.text(watermarkText, watermarkX + textWidth / 2, watermarkY, {
      angle: 45,
      align: "center",
    });
    doc.restoreGraphicsState();
  }

  if (logoBase64) {
    const logoY = y + 0.5;
    let logoHeightUsed = 14;

    try {
      const { width: logoW, height: logoH } = fitLogoDimensions(
        doc,
        logoBase64,
        42,
        14
      );
      logoHeightUsed = logoH;
      const logoX = (pageW - logoW) / 2;
      doc.addImage(
        logoBase64,
        "PNG",
        logoX,
        logoY,
        logoW,
        logoH,
        undefined,
        "FAST"
      );
    } catch (error) {
      logger.warn("Failed to add logo to branch section", {
        component: "invoiceGenerator",
        error: error?.message,
      });
    }

    y += logoHeightUsed + 2.5;
  }

  const accent = [13, 148, 136];
  const headerHeight = 13.5;
  doc.setFillColor(...accent);
  doc.setDrawColor(...accent);
  doc.setLineWidth(0.3);
  doc.rect(m, y, pageW - m * 2, headerHeight, "FD");

  const headerBrand = String(
    storeSettings?.name || branchName || ""
  ).toUpperCase();

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.text(headerBrand, pageW / 2, y + 4.6, { align: "center" });

  doc.setFontSize(7);
  setArFont(true);
  doc.text(label("cashSaleInvoice", true), pageW / 2, y + 9.2, {
    align: "center",
  });

  doc.setFontSize(5.5);
  doc.text(label("customerCopy", true), m + 2.5, y + 4.6);

  const invNum = String(invoice.invoice_number || "N/A").toUpperCase();
  doc.text(`#${invNum}`, pageW - m - 2.5, y + 4.6, { align: "right" });

  const headerMeta = `${formatDate(invoice)}  •  ${formatTime(invoice)}`;
  doc.text(headerMeta, m + 2.5, y + 9.2);

  if (storeSettings?.phone) {
    doc.setFont("helvetica", "normal");
    doc.text(`TEL ${storeSettings.phone}`, pageW - m - 2.5, y + 9.2, {
      align: "right",
    });
  }

  doc.setTextColor(0, 0, 0);
  y += headerHeight + 1.6;

  doc.setDrawColor(...brand);
  doc.setLineWidth(0.4);
  doc.line(m, y, pageW - m, y);
  y += 1.5;

  return y;
};

export const drawInvoiceFooterSection = ({
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
  ensurePageSpace,
}) => {
  const netAmountHeight = 8;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...brandDark);
  doc.rect(m, y - 0.5, pageW - 2 * m, netAmountHeight, "FD");
  doc.setTextColor(0, 0, 0);
  setArFont(true);
  doc.setFontSize(8.5);
  const valText = ` ${safeNum(invoice.total_amount, 0).toFixed(3)} KWD`;
  const labelText = `NET AMOUNT / الصافي :`;
  doc.text(labelText, pageW / 2, y + netAmountHeight / 2 + 0.8, {
    align: "right",
  });
  setArFont(false);
  doc.text(valText, pageW / 2, y + netAmountHeight / 2 + 0.8, {
    align: "left",
  });
  doc.setTextColor(0, 0, 0);
  y += netAmountHeight + 6;

  y = ensurePageSpace(16, y);

  const sigX = m;
  const sigW = pageW - 2 * m;
  const currentY = y;

  setArFont(true);
  doc.setFontSize(6.5);
  doc.setTextColor(0, 0, 0);
  doc.text("توقيع العميل", sigX + sigW - 3, currentY, { align: "right" });
  doc.text("اسم البائع/ 1.", sigX + 3, currentY);

  doc.setDrawColor(...brand);
  doc.setLineWidth(0.4);
  doc.line(sigX + sigW - 28, currentY + 1.5, sigX + sigW - 3, currentY + 1.5);
  doc.line(sigX + 3, currentY + 1.5, sigX + 28, currentY + 1.5);

  setArabicFont();
  doc.setFontSize(6.0);
  doc.text(safeStr(user?.full_name, "Admin"), sigX + 15.5, currentY + 6.5, {
    align: "center",
  });

  y = currentY + 6.0;

  const branchLoc = storeSettings?.branchLocation;
  const branchPh = storeSettings?.branchPhone;
  if (branchLoc || branchPh) {
    y = ensurePageSpace(6, y);
    y += 1.5;
    doc.setDrawColor(...brand);
    doc.setLineWidth(0.2);
    doc.line(m, y, pageW - m, y);
    y += 2.5;

    setArabicFont();
    doc.setFontSize(6.0);
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

  return y;
};
