/**
 * Transliterate Arabic (and common Persian) letters to Latin ASCII
 * so barcodes and slugs stay CODE128-safe and URL-safe.
 * Used when building barcode from custom category/subcategory/metal.
 */
const ARABIC_TO_LATIN = {
  ا: "a",
  أ: "a",
  إ: "a",
  آ: "a",
  ء: "",
  ؤ: "o",
  ئ: "y",
  ب: "b",
  پ: "p",
  ت: "t",
  ط: "t",
  ث: "t",
  ج: "j",
  چ: "ch",
  ح: "h",
  خ: "k",
  د: "d",
  ذ: "z",
  ر: "r",
  ز: "z",
  ژ: "zh",
  س: "s",
  ش: "s",
  ص: "s",
  ض: "d",
  ظ: "z",
  ع: "a",
  غ: "g",
  ف: "f",
  ق: "q",
  ك: "k",
  ک: "k",
  گ: "g",
  ل: "l",
  م: "m",
  ن: "n",
  ه: "h",
  ة: "h",
  و: "w",
  ي: "y",
  ى: "y",
  " ": " ",
  "-": "-",
  _: "_",
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
};

/**
 * Convert string to ASCII-safe Latin (for barcode / slug).
 * Arabic/Persian letters are transliterated; other non-ASCII are stripped.
 * @param {string} str - User input (e.g. category, subcategory, metal name)
 * @returns {string} - ASCII-only string (A-Z, a-z, 0-9, space, dash, underscore)
 */
export function transliterateToAscii(str) {
  if (str == null || typeof str !== "string") return "";
  let out = "";
  for (const char of str) {
    const lower = char.toLowerCase();
    if (ARABIC_TO_LATIN[char] !== undefined) {
      out += ARABIC_TO_LATIN[char];
    } else if (ARABIC_TO_LATIN[lower] !== undefined) {
      out += ARABIC_TO_LATIN[lower];
    } else if (/[a-zA-Z0-9\s\-_]/.test(char)) {
      out += char;
    }
    // else: skip other non-ASCII
  }
  return out.replace(/\s+/g, " ").trim();
}

/**
 * Get a short CODE128-safe code from a label (e.g. category name).
 * Transliterates, keeps only A-Z0-9, takes first maxLen chars, pads with X if needed.
 * @param {string} label - e.g. category or subcategory
 * @param {number} maxLen - default 3
 * @returns {string} - e.g. "GEN", "WAT", "NEW"
 */
export function toBarcodeSafeCode(label, maxLen = 3) {
  const t = transliterateToAscii(label || "");
  const safe = t
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase()
    .slice(0, maxLen);
  if (safe.length >= maxLen) return safe;
  return (safe + "X".repeat(maxLen)).slice(0, maxLen);
}
