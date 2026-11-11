import {
  sanitizeString,
  sanitizeText,
  sanitizeName,
  sanitizePhone,
} from "../utils/sanitize.js";

export const sanitizeInput = (req, res, next) => {
  try {

    if (req.body && typeof req.body === "object") {
      req.body = sanitizeObject(req.body);
    }

    if (req.query && typeof req.query === "object") {
      req.query = sanitizeObject(req.query);
    }

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

    next();
  }
};

const sanitizeObject = (obj) => {

  if (!obj || typeof obj !== "object") {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj;
  }

  const sanitized = { ...obj };

  for (const [key, value] of Object.entries(sanitized)) {
    if (value === null || value === undefined) {
      continue;
    }

    if (value && typeof value === "object" && value.fieldname) {
      continue;
    }

    if (typeof value === "object" && !Array.isArray(value)) {
      sanitized[key] = sanitizeObject(value);
      continue;
    }

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

        sanitized[key] = sanitizeString(value, 255).toLowerCase();
      } else if (lowerKey.includes("search")) {

        sanitized[key] = sanitizeString(value, 255);
      } else {

        sanitized[key] = sanitizeString(value, 1000);
      }
    }
  }

  return sanitized;
};

export default sanitizeInput;
