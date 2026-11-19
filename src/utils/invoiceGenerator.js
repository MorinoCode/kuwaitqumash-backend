import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import ExcelJS from "exceljs";
import { jsPDF } from "jspdf";
import sharp from "sharp";
import crypto from "crypto";
import logger from "./logger.js";
import { cacheGet, cacheSet } from "../config/redis.js";
import { formatKuwaitDate, formatKuwaitTime } from "./kuwaitTime.js";

const fontCache = new Map();

const safeNum = (v, def = 0) => {
  const num = Number.isFinite(v) ? v : parseFloat(v);
  return isNaN(num) ? def : num;
};

const safeStr = (v, def = "-") =>
  v != null && String(v).trim() !== "" ? String(v).trim() : def;

const formatDate = (inv) => formatKuwaitDate(inv?.created_at || inv?.createdAt);

const formatTime = (inv) => formatKuwaitTime(inv?.created_at || inv?.createdAt);

async function getImageAsBase64(
  url,
  preserveTransparency = false,
  opacity = 1.0
) {
  if (!url || typeof url !== "string") return null;
  const u = url.trim();
  const hash = crypto.createHash("md5").update(u).digest("hex");
  const cacheKey = `img_b64:${hash}:${preserveTransparency}:${opacity}`;
  try {
    const cachedData = await cacheGet(cacheKey);
    if (cachedData) return cachedData;
  } catch (err) {
    logger.debug("Image cache get error", { error: err.message });
  }
  let result = null;
  try {
    if (u.startsWith("http://") || u.startsWith("https://")) {
      const res = await axios.get(u, {
        responseType: "arraybuffer",
        timeout: 10000,
      });
      const buf = Buffer.from(res.data);
      if (preserveTransparency || opacity < 1.0) {
        try {
          let sharpInstance = sharp(buf);
          if (opacity < 1.0) {
            sharpInstance = sharpInstance.ensureAlpha();
            const { data, info } = await sharpInstance
              .raw()
              .toBuffer({ resolveWithObject: true });
            for (let i = 3; i < data.length; i += 4) {
              const currentAlpha = data[i];
              data[i] = Math.round(currentAlpha * opacity);
            }
            sharpInstance = sharp(data, {
              raw: {
                width: info.width,
                height: info.height,
                channels: 4,
              },
            });
          }
          const processedBuffer = await sharpInstance
            .png({ quality: 100, compressionLevel: 6, adaptiveFiltering: true })
            .toBuffer();
          result = `data:image/png;base64,${processedBuffer.toString("base64")}`;
        } catch (sharpError) {
          logger.warn(
            "Sharp processing failed, falling back to direct conversion",
            {
              component: "invoiceGenerator",
              error: sharpError?.message,
            }
          );
          const ct = (res.headers["content-type"] || "").toLowerCase();
          const mime = ct.includes("png")
            ? "image/png"
            : ct.includes("webp")
            ? "image/webp"
            : "image/jpeg";
          result = `data:${mime};base64,${buf.toString("base64")}`;
        }
      } else {
        const ct = (res.headers["content-type"] || "").toLowerCase();
        const mime = ct.includes("png")
          ? "image/png"
          : ct.includes("webp")
          ? "image/webp"
          : "image/jpeg";
        result = `data:${mime};base64,${buf.toString("base64")}`;
      }
    } else if (u.startsWith("/uploads")) {
      const localPath = path.join(process.cwd(), "public", u);
      if (fs.existsSync(localPath)) {
        const buf = fs.readFileSync(localPath);
        const ext = path.extname(localPath).toLowerCase();
        const mime = ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
        result = `data:${mime};base64,${buf.toString("base64")}`;
      }
    }
    if (result) {
      try {
        await cacheSet(cacheKey, result, 86400 * 7);
      } catch (cacheSetErr) {
        logger.debug("Image cache set error", { error: cacheSetErr.message });
      }
    }
    return result;
  } catch (e) {
    logger.warn("getImageAsBase64 failed", {
      component: "invoiceGenerator",
      error: e?.message,
    });
    return null;
  }
}

function loadInvoiceFonts(doc) {
  let hasCairo = false;
  let hasCairoBold = false;
  let hasNoto = false;
  let hasNotoBold = false;
  let hasAmiri = false;
  let hasAmiriBold = false;
  try {
    const fonts = [
      { name: "Cairo-Regular.ttf", id: "Cairo", style: "normal" },
      { name: "Cairo-Bold.ttf", id: "Cairo", style: "bold" },
      { name: "NotoSans-Regular.ttf", id: "NotoSans", style: "normal" },
      { name: "NotoSans-Bold.ttf", id: "NotoSans", style: "bold" },
      { name: "Amiri-Regular.ttf", id: "Amiri", style: "normal" },
      { name: "Amiri-Bold.ttf", id: "Amiri", style: "bold" },
    ];
    fonts.forEach((f) => {
      let base64 = fontCache.get(f.name);
      if (!base64) {
        const candidatePaths = [
          path.join(process.cwd(), "fonts", f.name),
          path.join(process.cwd(), "backend", "fonts", f.name),
          path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fonts", f.name),
        ];
        for (const fontPath of candidatePaths) {
          if (fs.existsSync(fontPath)) {
            const buf = fs.readFileSync(fontPath);
            base64 = buf.toString("base64");
            fontCache.set(f.name, base64);
            break;
          }
        }
      }
      if (base64) {
        doc.addFileToVFS(f.name, base64);
        doc.addFont(f.name, f.id, f.style);
        if (f.id === "Cairo") {
          hasCairo = true;
          if (f.style === "bold") hasCairoBold = true;
        }
        if (f.id === "NotoSans") {
          hasNoto = true;
          if (f.style === "bold") hasNotoBold = true;
        }
        if (f.id === "Amiri") {
          hasAmiri = true;
          if (f.style === "bold") hasAmiriBold = true;
        }
      }
    });
  } catch (e) {
    logger.warn("Font load failed", {
      component: "invoiceGenerator",
      error: e?.message,
    });
  }
  return { hasCairo, hasCairoBold, hasNoto, hasNotoBold, hasAmiri, hasAmiriBold };
}

const L = {
  invoice: { en: "INVOICE", ar: "فاتورة" },
  fabricInvoice: { en: "FABRIC INVOICE", ar: "فاتورة أقمشة" },
  cashSaleInvoice: { en: "Fabric Sale Invoice", ar: "فاتورة بيع أقمشة" },
  customerCopy: { en: "Customer Copy", ar: "نسخة العميل" },
  customerDetails: { en: "Customer Details", ar: "بيانات العميل" },
  invoiceDetails: { en: "Invoice Details", ar: "تفاصيل الفاتورة" },
  name: { en: "Name", ar: "الاسم" },
  phone: { en: "Phone", ar: "الهاتف" },
  location: { en: "Location", ar: "الموقع" },
  address: { en: "Address", ar: "العنوان" },
  customerType: { en: "Customer Type", ar: "نوع العميل" },
  date: { en: "Date", ar: "التاريخ" },
  time: { en: "Time", ar: "الوقت" },
  salesman: { en: "Salesman", ar: "البائع" },
  payment: { en: "Payment", ar: "الدفع" },
  itemCode: { en: "Item Code", ar: "رمز الصنف" },
  quantity: { en: "Qty", ar: "الكمية" },
  workmanship: { en: "Discount", ar: "الخصم" },
  totalMeters: { en: "Total Meters", ar: "مجموع الأمتار" },
  grandTotal: { en: "Grand Total", ar: "الإجمالي" },
  purchasePurpose: { en: "Purchase Purpose", ar: "الغرض من الشراء" },
  purposeHome: { en: "Home", ar: "منزل" },
  purposeTailoring: { en: "Tailoring", ar: "خياطة" },
  purposeTrade: { en: "Trade", ar: "تجارة" },
  purposeGift: { en: "Gift", ar: "هدية" },
  purposeOther: { en: "Other", ar: "أخرى" },
  notes: { en: "Notes", ar: "ملاحظات" },
  netAmount: { en: "NET AMOUNT", ar: "الصافي" },
  paymentMethod: { en: "Payment Method", ar: "طريقة الدفع" },
  totalPaid: { en: "Total Paid", ar: "إجمالي المدفوعات" },
  remainingAmount: { en: "Remaining Amount", ar: "المبلغ المتبقى" },
  sellerSig: { en: "Seller Signature", ar: "توقيع البائع" },
  customerSig: { en: "Customer Signature", ar: "توقيع العميل" },
  idCards: { en: "ID Cards", ar: "بطاقات الهوية" },
  creditNote: { en: "CREDIT NOTE", ar: "إشعار مرتجع" },
  creditNoteDesc: {
    en: "Refund document for the original invoice. Certifies items and amounts returned.",
    ar: "وثيقة مرتجع للفاتورة الأصلية. يثبت الأصناف والمبالغ المرتجعة.",
  },
  originalInvoice: { en: "Original Invoice", ar: "الفاتورة الأصلية" },
  refundAmount: { en: "Refund Amount", ar: "مبلغ المرتجع" },
  item: { en: "Item", ar: "الصنف" },
};

function label(key, useAr) {
  const o = L[key];
  if (!o) return key;
  if (useAr && o.ar) {
    return `${o.en} / ${o.ar}`;
  }
  return o.en;
}

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
  let currentPage = 1;

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

  const setEnFont = (bold = false) => {
    if (fonts.hasNoto) {
      doc.setFont("NotoSans", bold && fonts.hasNotoBold ? "bold" : "normal");
    } else if (fonts.hasAmiri) {
      doc.setFont("Amiri", bold && fonts.hasAmiriBold ? "bold" : "normal");
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
      currentPage++;
      y = m;

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

  const headerBrand =
    String(storeSettings?.name || branchName || "").toUpperCase();

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9.5);
  doc.text(headerBrand, pageW / 2, y + 4.6, { align: "center" });

  doc.setFontSize(7);
  setArFont(true);
  doc.text(label("cashSaleInvoice", true), pageW / 2, y + 9.2, { align: "center" });

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

  const netAmountHeight = 8;
  doc.setFillColor(255, 255, 255);
  doc.setDrawColor(...brandDark);
  doc.rect(m, y - 0.5, pageW - 2 * m, netAmountHeight, "FD");
  doc.setTextColor(0, 0, 0);
  setArFont(true);
  doc.setFontSize(8.5);
  const valText = ` ${safeNum(invoice.total_amount, 0).toFixed(3)} KWD`;
  const labelText = `NET AMOUNT / الصافي :`;
  doc.text(labelText, pageW / 2, y + netAmountHeight / 2 + 0.8, { align: "right" });
  setArFont(false);
  doc.text(valText, pageW / 2, y + netAmountHeight / 2 + 0.8, { align: "left" });
  doc.setTextColor(0, 0, 0);
  y += netAmountHeight + 2;

  const termsAr =
    "الشروط والأحكام: الأقمشة المقصوصة أو المعدّلة حسب الطلب لا تُرد ولا تُستبدل. الاستبدال خلال ٣ أيام بوجود الفاتورة الأصلية وبشرط أن تكون البضاعة بحالتها الأصلية وغير مستخدمة. الكميات المقصوصة نهائية بعد إتمام القص.";

  const termsBoxW = pageW - 2 * m - 4;
  doc.setFontSize(5.5);
  setArFont(false);
  const termsArLines = doc.splitTextToSize(termsAr, termsBoxW);
  const termsHeight = 3.0 + termsArLines.length * 3.0 + 1.5;

  checkPageBreak(termsHeight + 2);

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
  checkPageBreak(kycHeight);

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

  currentY = y;

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
  doc.text(safeStr(user?.full_name, "Admin"), kycX + 15.5, currentY + 6.5, { align: "center" });

  y = currentY + 6.0;

  const branchLoc = storeSettings?.branchLocation;
  const branchPh = storeSettings?.branchPhone;
  if (branchLoc || branchPh) {
    checkPageBreak(6);
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

  const buffer = Buffer.from(doc.output("arraybuffer"));
  return { buffer };
};

export const generateInvoicePDFAsBuffer = generateInvoicePDF;

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

  const setEnFont = (bold = false) => {
    if (fonts.hasNoto) {
      doc.setFont("NotoSans", bold && fonts.hasNotoBold ? "bold" : "normal");
    } else if (fonts.hasAmiri) {
      doc.setFont("Amiri", bold && fonts.hasAmiriBold ? "bold" : "normal");
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
