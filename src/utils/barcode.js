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

/** Fabric type -> 2 letter barcode prefix (works for custom/Arabic names too). */
function fabricToCode(fabric) {
  if (!fabric || typeof fabric !== "string") return "FB";
  const code = toBarcodeSafeCode(fabric.trim(), 2);
  return code && code !== "X" ? code : "FB";
}

export const generateUniqueBarcode = async (Model, fabricType, design, variant) => {
  let isUnique = false;
  let barcode = "";
  let attempts = 0;

  const fabricCode = fabricToCode(fabricType);
  const designCode =
    design && String(design).trim() ? toBarcodeSafeCode(design, 3) : "GEN";
  // Optional variant code (e.g. width in cm) kept as two digits
  let variantCode = "00";
  if (variant != null && String(variant).trim() !== "") {
    const v = normalizeToLatinDigits(String(variant))
      .replace(/\D/g, "")
      .slice(0, 2);
    variantCode = v.length >= 1 ? v.padEnd(2, "0") : "00";
  }

  while (!isUnique && attempts < 10) {
    const randomPart = generateRandomString(8);
    barcode = `${fabricCode}-${designCode}-${variantCode}-${randomPart}`;

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
