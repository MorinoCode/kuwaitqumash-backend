import logger from "./logger.js";
import {
  safeNum,
  safeStr,
  formatDate,
  formatTime,
  L,
  label,
} from "./invoicePdfHelpers.js";

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
      const logoSize = 50;
      const watermarkX = (pageW - logoSize) / 2;
      const watermarkY = (pageH - logoSize) / 2;
      doc.addImage(
        logoBase64Watermark,
        "PNG",
        watermarkX,
        watermarkY,
        logoSize,
        logoSize,
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

  const branchSectionHeight = 8;

  if (logoBase64) {
    const logoSize = 6;
    const logoY = y + 0.5;

    try {
      const logoX = (pageW - logoSize) / 2;
      doc.addImage(
        logoBase64,
        "PNG",
        logoX,
        logoY,
        logoSize,
        logoSize,
        undefined,
        "FAST"
      );
    } catch (error) {
      logger.warn("Failed to add logo to branch section", {
        component: "invoiceGenerator",
        error: error?.message,
      });
    }

    y += branchSectionHeight + 0.5;
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
  brandLight,
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
  y += netAmountHeight + 2;

  const termsAr =
    "الشروط والأحكام: الأقمشة المقصوصة أو المعدّلة حسب الطلب لا تُرد ولا تُستبدل. الاستبدال خلال ٣ أيام بوجود الفاتورة الأصلية وبشرط أن تكون البضاعة بحالتها الأصلية وغير مستخدمة. الكميات المقصوصة نهائية بعد إتمام القص.";

  const termsBoxW = pageW - 2 * m - 4;
  doc.setFontSize(5.5);
  setArFont(false);
  const termsArLines = doc.splitTextToSize(termsAr, termsBoxW);
  const termsHeight = 3.0 + termsArLines.length * 3.0 + 1.5;

  y = ensurePageSpace(termsHeight + 2, y);

  doc.setDrawColor(...brandDark);
  doc.setLineWidth(0.4);
  doc.rect(m, y - 0.5, pageW - 2 * m, termsHeight);
  doc.setFillColor(...brandLight);
  doc.rect(m + 0.3, y - 0.3, pageW - 2 * m - 0.6, termsHeight - 0.6, "F");

  doc.setTextColor(80, 80, 80);

  const arStartY = y + 2.5;
  setArFont(false);
  termsArLines.forEach((line, idx) => {
    doc.text(line, pageW - m - 1.5, arStartY + idx * 3.0, {
      maxWidth: termsBoxW,
      align: "right",
    });
  });

  y += termsHeight + 4.5;

  const kycHeight = 2 * 6.5 + 16;
  y = ensurePageSpace(kycHeight, y);

  const kycX = m;
  const kycW = pageW - 2 * m;
  const rowH = 6.5;

  doc.setDrawColor(...brandDark);
  doc.setLineWidth(0.2);

  const drawCell = (x, cellY, w, h, bg = null) => {
    if (bg) {
      doc.setFillColor(...bg);
      doc.rect(x, cellY, w, h, "F");
    }
    doc.rect(x, cellY, w, h);
  };

  const drawCheckboxWithText = (rightX, midY, text) => {
    const boxS = 1.8;
    const boxX = rightX - boxS - 1.0;
    const boxY = midY - boxS / 2;
    doc.setDrawColor(...brandDark);
    doc.rect(boxX, boxY, boxS, boxS);
    setArFont(false);
    doc.text(text, boxX - 1.0, midY + 1.2, { align: "right" });
  };

  const headerBg = brandLight;

  const drawRowHeader = (rowY, width, text) => {
    const rx = kycX + kycW;
    drawCell(rx - width, rowY, width, rowH, headerBg);
    setArFont(true);
    doc.setFontSize(6.0);
    doc.setTextColor(0, 0, 0);
    doc.text(text, rx - width / 2, rowY + rowH / 2 + 1.2, { align: "center" });
  };

  let currentY = y;

  const purposeOptions = [
    "purposeHome",
    "purposeTailoring",
    "purposeTrade",
    "purposeGift",
    "purposeOther",
  ];
  const purposeHeaderW = kycW * 0.18;
  drawRowHeader(currentY, purposeHeaderW, L.purchasePurpose.ar);

  let rx = kycX + kycW - purposeHeaderW;
  const optionW = (rx - kycX) / purposeOptions.length;
  purposeOptions.forEach((key) => {
    drawCell(rx - optionW, currentY, optionW, rowH);
    drawCheckboxWithText(rx, currentY + rowH / 2, L[key].ar);
    rx -= optionW;
  });
  currentY += rowH;

  const notesHeaderW = kycW * 0.18;
  drawRowHeader(currentY, notesHeaderW, L.notes.ar);
  drawCell(kycX, currentY, kycW - notesHeaderW, rowH);
  currentY += rowH + 8;

  setArFont(true);
  doc.setFontSize(6.5);
  doc.setTextColor(0, 0, 0);
  doc.text("توقيع العميل", kycX + kycW - 3, currentY, { align: "right" });
  doc.text("اسم البائع/ 1.", kycX + 3, currentY);

  doc.setDrawColor(...brand);
  doc.setLineWidth(0.4);
  doc.line(kycX + kycW - 28, currentY + 1.5, kycX + kycW - 3, currentY + 1.5);
  doc.line(kycX + 3, currentY + 1.5, kycX + 28, currentY + 1.5);

  setArabicFont();
  doc.setFontSize(6.0);
  doc.text(safeStr(user?.full_name, "Admin"), kycX + 15.5, currentY + 6.5, {
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
