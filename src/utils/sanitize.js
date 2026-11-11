import { normalizeToLatinDigits } from "./normalizeNumbers.js";

export const sanitizeString = (input, maxLength = 5000) => {
  if (!input || typeof input !== "string") return "";

  let sanitized = input.replace(/<[^>]*>/g, "");

  sanitized = sanitized.replace(/[<>"']/g, "");

  sanitized = sanitized.trim().substring(0, maxLength);

  return sanitized;
};

export const sanitizeText = (input) => {
  return sanitizeString(input, 5000);
};

export const sanitizeName = (input) => {
  return sanitizeString(input, 255);
};

export const sanitizePhone = (input) => {
  if (!input || typeof input !== "string") return "";
  const normalized = normalizeToLatinDigits(input);
  return normalized.replace(/[^\d+\s-]/g, "").trim();
};

export const sanitizeNumber = (input) => {
  if (typeof input === "number") return input;
  if (typeof input !== "string") return null;
  const parsed = parseFloat(normalizeToLatinDigits(input));
  return isNaN(parsed) ? null : parsed;
};

export const sanitizeInteger = (input) => {
  if (typeof input === "number") return Math.floor(input);
  if (typeof input !== "string") return null;
  const parsed = parseInt(normalizeToLatinDigits(input), 10);
  return isNaN(parsed) ? null : parsed;
};

export const sanitizeObject = (obj, schema) => {
  if (!obj || typeof obj !== "object") return {};

  const sanitized = { ...obj };

  for (const [key, sanitizer] of Object.entries(schema)) {
    if (
      key in sanitized &&
      sanitized[key] !== null &&
      sanitized[key] !== undefined
    ) {
      if (typeof sanitizer === "function") {
        sanitized[key] = sanitizer(sanitized[key]);
      } else if (typeof sanitizer === "object" && sanitizer.type) {
        switch (sanitizer.type) {
          case "string":
            sanitized[key] = sanitizeString(
              sanitized[key],
              sanitizer.maxLength
            );
            break;
          case "text":
            sanitized[key] = sanitizeText(sanitized[key]);
            break;
          case "name":
            sanitized[key] = sanitizeName(sanitized[key]);
            break;
          case "phone":
            sanitized[key] = sanitizePhone(sanitized[key]);
            break;
          case "number":
            sanitized[key] = sanitizeNumber(sanitized[key]);
            break;
          case "integer":
            sanitized[key] = sanitizeInteger(sanitized[key]);
            break;
        }
      }
    }
  }

  return sanitized;
};
