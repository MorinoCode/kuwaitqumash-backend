/**
 * Input sanitization middleware
 * Automatically sanitizes request body, query, and params
 */
import {
  sanitizeString,
  sanitizeText,
  sanitizeName,
  sanitizePhone,
} from "../utils/sanitize.js";

/**
 * Sanitize request body, query, and params
 */
export const sanitizeInput = (req, res, next) => {
  try {
    // Sanitize body
    if (req.body && typeof req.body === "object") {
      req.body = sanitizeObject(req.body);
    }

    // Sanitize query
    if (req.query && typeof req.query === "object") {
      req.query = sanitizeObject(req.query);
    }

    // Sanitize params (only string values)
    if (req.params && typeof req.params === "object") {
      for (const [key, value] of Object.entries(req.params)) {
        if (typeof value === "string") {
          req.params[key] = sanitizeString(value, 255);
        }
      }
    }

    next();
  } catch (error) {
    void error;
    // If sanitization fails, continue anyway (don't break the request)
    next();
  }
};

/**
 * Sanitize object recursively
 */
const sanitizeObject = (obj) => {
  // Handle null, undefined, or non-objects
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  // Handle arrays - return as-is (will be sanitized element-wise if needed)
  if (Array.isArray(obj)) {
    return obj;
  }

  const sanitized = { ...obj };

  for (const [key, value] of Object.entries(sanitized)) {
    if (value === null || value === undefined) {
      continue;
    }

    // Skip files (multer)
    if (value && typeof value === "object" && value.fieldname) {
      continue;
    }

    // Recursively sanitize nested objects
    if (typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeObject(value);
      continue;
    }

    // Sanitize arrays
    if (Array.isArray(value)) {
      sanitized[key] = value.map((item) => {
        if (typeof item === "string") {
          return sanitizeString(item);
        } else if (typeof item === "object") {
          return sanitizeObject(item);
        }
        return item;
      });
      continue;
    }

    // Sanitize strings based on field name patterns
    if (typeof value === "string") {
      const lowerKey = key.toLowerCase();

      if (lowerKey.includes("name") || lowerKey.includes("title")) {
        sanitized[key] = sanitizeName(value);
      } else if (lowerKey.includes("phone") || lowerKey.includes("mobile")) {
        sanitized[key] = sanitizePhone(value);
      } else if (
        lowerKey.includes("note") ||
        lowerKey.includes("description") ||
        lowerKey.includes("comment")
      ) {
        sanitized[key] = sanitizeText(value);
      } else if (lowerKey.includes("email")) {
        // Email sanitization (basic)
        sanitized[key] = sanitizeString(value, 255).toLowerCase();
      } else if (lowerKey.includes("search")) {
        // Search fields - less aggressive sanitization
        sanitized[key] = sanitizeString(value, 255);
      } else {
        // Default string sanitization
        sanitized[key] = sanitizeString(value, 1000);
      }
    }
  }

  return sanitized;
};

export default sanitizeInput;
