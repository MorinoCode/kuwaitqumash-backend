/**
 * Phone number utilities for WhatsApp and general use
 *
 * Format requirements for WhatsApp:
 * - Only digits (0-9)
 * - Must include country code
 * - No spaces, dashes, parentheses, or plus signs
 *
 * For Kuwait:
 * - Country code: 965
 * - Format: 965XXXXXXXX (8 digits after country code)
 * - Examples:
 *   - 96512345678 ✅
 *   - 9651234567 ✅
 *   - 12345678 ❌ (missing country code)
 *   - +96512345678 ✅ (will be normalized to 96512345678)
 *   - 0096512345678 ✅ (will be normalized to 96512345678)
 */

import { normalizeToLatinDigits } from "./normalizeNumbers.js";

/**
 * Normalize phone number for storage and WhatsApp
 * Removes all non-digit characters
 * Handles common formats:
 * - +96512345678 -> 96512345678
 * - 0096512345678 -> 96512345678
 * - 965-1234-5678 -> 96512345678
 * - (965) 1234-5678 -> 96512345678
 * - Arabic/Persian digits (٠١٢٣٤٥٦٧٨٩, ۰۱۲۳۴۵۶۷۸۹) -> 0-9
 *
 * @param {string} phone - Phone number in any format
 * @returns {string} - Normalized phone (digits only)
 */
export const normalizePhone = (phone) => {
  if (!phone) return "";

  // Convert Arabic/Persian digits to Latin first
  let normalized = normalizeToLatinDigits(String(phone));
  // Remove all non-digit characters
  normalized = normalized.replace(/[^0-9]/g, "");

  // Handle common prefixes
  if (normalized.startsWith("00")) {
    // Remove leading 00 (international format)
    normalized = normalized.substring(2);
  } else if (normalized.startsWith("0") && normalized.length > 8) {
    // Remove leading 0 if it's a local format with country code
    // e.g., 096512345678 -> 96512345678
    if (normalized.length >= 12) {
      normalized = normalized.substring(1);
    }
  }

  return normalized;
};

/**
 * Validate phone number format
 * For Kuwait: Should start with 965 and have 11-12 digits total
 *
 * @param {string} phone - Phone number
 * @returns {boolean} - True if valid format
 */
export const isValidPhoneFormat = (phone) => {
  const normalized = normalizePhone(phone);

  if (!normalized || normalized.length < 8 || normalized.length > 15) {
    return false;
  }

  // For Kuwait numbers, should start with 965
  // But we allow other country codes too
  return /^[1-9]\d{7,14}$/.test(normalized);
};

/**
 * Format phone for WhatsApp JID
 * Converts to format: 96512345678@s.whatsapp.net
 *
 * @param {string} phone - Phone number
 * @returns {string|null} - WhatsApp JID or null if invalid
 */
export const formatPhoneForWhatsApp = (phone) => {
  const normalized = normalizePhone(phone);

  if (!normalized || normalized.length < 8) {
    return null;
  }

  return normalized + "@s.whatsapp.net";
};

/**
 * Format phone for display
 * Formats Kuwait numbers: 965 1234 5678
 *
 * @param {string} phone - Phone number
 * @returns {string} - Formatted phone for display
 */
export const formatPhoneForDisplay = (phone) => {
  const normalized = normalizePhone(phone);

  if (!normalized) return phone || "";

  // Format Kuwait numbers: 965 1234 5678
  if (normalized.startsWith("965") && normalized.length === 11) {
    return `965 ${normalized.substring(3, 7)} ${normalized.substring(7)}`;
  }

  // For other formats, just return normalized
  return normalized;
};

/**
 * Get country code from phone number
 *
 * @param {string} phone - Phone number
 * @returns {string|null} - Country code or null
 */
export const getCountryCode = (phone) => {
  const normalized = normalizePhone(phone);

  if (!normalized || normalized.length < 8) {
    return null;
  }

  // Common country codes (1-3 digits)
  if (normalized.startsWith("965")) return "965"; // Kuwait
  if (normalized.startsWith("1") && normalized.length === 11) return "1"; // US/Canada
  if (normalized.startsWith("44")) return "44"; // UK
  if (normalized.startsWith("971")) return "971"; // UAE
  if (normalized.startsWith("966")) return "966"; // Saudi Arabia

  // Default: assume first 1-3 digits are country code
  if (normalized.length >= 10) {
    return normalized.substring(0, Math.min(3, normalized.length - 7));
  }

  return null;
};
