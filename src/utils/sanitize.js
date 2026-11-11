import { normalizeToLatinDigits } from "./normalizeNumbers.js";

/**
 * Input sanitization utilities
 * Sanitizes user inputs to prevent XSS and injection attacks
 */

/**
 * Sanitize a string input
 * Removes HTML tags and dangerous characters
 * @param {string} input - The input string to sanitize
 * @param {number} maxLength - Maximum allowed length (default: 5000)
 * @returns {string} - Sanitized string
 */
export const sanitizeString = (input, maxLength = 5000) => {
  if (!input || typeof input !== "string") return "";

  // Remove HTML tags
  let sanitized = input.replace(/<[^>]*>/g, "");

  // Remove dangerous characters but keep Arabic/Persian characters
  sanitized = sanitized.replace(/[<>"']/g, "");

  // Trim and limit length
  sanitized = sanitized.trim().substring(0, maxLength);

  return sanitized;
};

/**
 * Sanitize text fields (notes, descriptions, etc.)
 * @param {string} input - The input text
 * @returns {string} - Sanitized text
 */
export const sanitizeText = (input) => {
  return sanitizeString(input, 5000);
};

/**
 * Sanitize name fields
 * @param {string} input - The input name
 * @returns {string} - Sanitized name
 */
export const sanitizeName = (input) => {
  return sanitizeString(input, 255);
};

/**
 * Sanitize phone number
 * Removes all non-numeric characters except + and spaces
 * @param {string} input - The input phone number
 * @returns {string} - Sanitized phone number
 */
export const sanitizePhone = (input) => {
  if (!input || typeof input !== "string") return "";
  const normalized = normalizeToLatinDigits(input);
  return normalized.replace(/[^\d+\s-]/g, "").trim();
};

/**
 * Sanitize numeric input
 * @param {string|number} input - The input number
 * @returns {number|null} - Parsed number or null if invalid
 */
export const sanitizeNumber = (input) => {
  if (typeof input === "number") return input;
  if (typeof input !== "string") return null;
  const parsed = parseFloat(normalizeToLatinDigits(input));
  return isNaN(parsed) ? null : parsed;
};

/**
 * Sanitize integer input
 * @param {string|number} input - The input integer
 * @returns {number|null} - Parsed integer or null if invalid
 */
export const sanitizeInteger = (input) => {
  if (typeof input === "number") return Math.floor(input);
  if (typeof input !== "string") return null;
  const parsed = parseInt(normalizeToLatinDigits(input), 10);
  return isNaN(parsed) ? null : parsed;
};

/**
 * Sanitize object recursively
 * @param {object} obj - The object to sanitize
 * @param {object} schema - Schema defining which fields to sanitize and how
 * @returns {object} - Sanitized object
 */
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
