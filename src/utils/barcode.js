import { toBarcodeSafeCode } from "./transliterate.js";
import { normalizeToLatinDigits } from "./normalizeNumbers.js";

const generateRandomString = (length) => {
  const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

/** Metal name may be custom (e.g. Arabic); map known ones, else use first letter from transliterated. */
function metalToCode(metal) {
  if (!metal || typeof metal !== "string") return "D";
  const m = metal.trim();
  if (m === "Gold") return "G";
  if (m === "Silver") return "S";
  if (m === "Platinum") return "P";
  if (m === "Diamond") return "D";
  if (m === "Watch") return "W";
  const t = toBarcodeSafeCode(m, 1);
  return t && t !== "X" ? t : "D";
}

export const generateUniqueBarcode = async (Model, metal, category, karat) => {
  let isUnique = false;
  let barcode = "";
  let attempts = 0;

  const metalCode = metalToCode(metal);
  const catCode =
    category && String(category).trim()
      ? toBarcodeSafeCode(category, 3)
      : "GEN";
  // Diamond/Watch have no karat; otherwise normalize karat (Arabic digits → Latin), digits only
  let karatCode = "00";
  if (
    metalCode !== "D" &&
    metalCode !== "W" &&
    karat != null &&
    String(karat).trim() !== ""
  ) {
    const k = normalizeToLatinDigits(String(karat))
      .replace(/\D/g, "")
      .slice(0, 2);
    karatCode = k.length >= 1 ? k.padEnd(2, "0") : "00";
  }

  while (!isUnique && attempts < 10) {
    const randomPart = generateRandomString(8);
    barcode = `${metalCode}-${catCode}-${karatCode}-${randomPart}`;

    // Optimize: Use findOne with only barcode field (uses index) and limit 1
    const existing = await Model.findOne({
      where: { barcode },
      attributes: ["id"], // Only fetch id field for faster query
      limit: 1,
    });

    if (!existing) {
      isUnique = true;
    }
    attempts++;
  }

  if (!isUnique)
    throw new Error(
      "Could not generate a unique barcode after multiple attempts."
    );

  return barcode;
};
