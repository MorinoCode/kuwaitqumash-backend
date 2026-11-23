import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import axios from "axios";
import sharp from "sharp";
import crypto from "crypto";
import logger from "./logger.js";
import { cacheGet, cacheSet } from "../config/redis.js";
import { formatKuwaitDate, formatKuwaitTime } from "./kuwaitTime.js";

const fontCache = new Map();
const BACKEND_PUBLIC_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "public"
);

const resolveLocalUploadPath = (rawUrl) => {
  const normalized = String(rawUrl || "").replace(/^\/+/, "");
  if (!normalized.startsWith("uploads/")) return null;

  const candidates = [
    path.resolve(process.cwd(), "public", normalized),
    path.resolve(BACKEND_PUBLIC_DIR, normalized),
  ];

  for (const candidate of candidates) {
    const allowedRoots = [
      path.resolve(process.cwd(), "public", "uploads"),
      path.resolve(BACKEND_PUBLIC_DIR, "uploads"),
    ];
    const isInsideUploads = allowedRoots.some(
      (root) =>
        candidate === root || candidate.startsWith(`${root}${path.sep}`)
    );
    if (isInsideUploads && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
};

const encodeImageBuffer = async (buf, fallbackMime, preserveTransparency, opacity) => {
  if (preserveTransparency || opacity < 1.0) {
    try {
      let sharpInstance = sharp(buf);
      if (opacity < 1.0) {
        const alphaByte = Math.max(0, Math.min(255, Math.round(opacity * 255)));
        sharpInstance = sharpInstance.ensureAlpha().composite([
          {
            input: Buffer.from([255, 255, 255, alphaByte]),
            raw: { width: 1, height: 1, channels: 4 },
            tile: true,
            blend: "dest-in",
          },
        ]);
      }
      const processedBuffer = await sharpInstance
        .png({ quality: 100, compressionLevel: 6, adaptiveFiltering: true })
        .toBuffer();
      return `data:image/png;base64,${processedBuffer.toString("base64")}`;
    } catch (sharpError) {
      logger.warn(
        "Sharp processing failed, falling back to direct conversion",
        {
          component: "invoiceGenerator",
          error: sharpError?.message,
        }
      );
    }
  }
  return `data:${fallbackMime};base64,${buf.toString("base64")}`;
};

export const safeNum = (v, def = 0) => {
  const num = Number.isFinite(v) ? v : parseFloat(v);
  return isNaN(num) ? def : num;
};

export const safeStr = (v, def = "-") =>
  v != null && String(v).trim() !== "" ? String(v).trim() : def;

export const formatDate = (inv) => formatKuwaitDate(inv?.created_at || inv?.createdAt);

export const formatTime = (inv) => formatKuwaitTime(inv?.created_at || inv?.createdAt);

export async function getImageAsBase64(
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
      const ct = (res.headers["content-type"] || "").toLowerCase();
      const fallbackMime = ct.includes("png")
        ? "image/png"
        : ct.includes("webp")
        ? "image/webp"
        : "image/jpeg";
      result = await encodeImageBuffer(buf, fallbackMime, preserveTransparency, opacity);
    } else if (u.startsWith("/uploads/") || u.startsWith("uploads/")) {
      const localPath = resolveLocalUploadPath(u);
      if (localPath) {
        try {
          const buf = await fs.promises.readFile(localPath);
          const ext = path.extname(localPath).toLowerCase();
          const fallbackMime =
            ext === ".png" ? "image/png" : ext === ".webp" ? "image/webp" : "image/jpeg";
          result = await encodeImageBuffer(
            buf,
            fallbackMime,
            preserveTransparency,
            opacity
          );
        } catch (readErr) {
          if (readErr?.code !== "ENOENT") {
            logger.debug("Local logo read error", { error: readErr?.message });
          }
        }
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

export function loadInvoiceFonts(doc) {
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

export const L = {
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

export function label(key, useAr) {
  const o = L[key];
  if (!o) return key;
  if (useAr && o.ar) {
    return `${o.en} / ${o.ar}`;
  }
  return o.en;
}

