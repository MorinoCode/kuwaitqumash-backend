import { normalizeToLatinDigits } from "./normalizeNumbers.js";

export const normalizePhone = (phone) => {
  if (!phone) return "";

  let normalized = normalizeToLatinDigits(String(phone));

  normalized = normalized.replace(/[^0-9]/g, "");

  if (normalized.startsWith("00")) {

    normalized = normalized.substring(2);
  } else if (normalized.startsWith("0") && normalized.length > 8) {

    if (normalized.length >= 12) {
      normalized = normalized.substring(1);
    }
  }

  return normalized;
};

export const isValidPhoneFormat = (phone) => {
  const normalized = normalizePhone(phone);

  if (!normalized || normalized.length < 8 || normalized.length > 15) {
    return false;
  }

  return /^[1-9]\d{7,14}$/.test(normalized);
};

export const formatPhoneForWhatsApp = (phone) => {
  const normalized = normalizePhone(phone);

  if (!normalized || normalized.length < 8) {
    return null;
  }

  return normalized + "@s.whatsapp.net";
};

export const formatPhoneForDisplay = (phone) => {
  const normalized = normalizePhone(phone);

  if (!normalized) return phone || "";

  if (normalized.startsWith("965") && normalized.length === 11) {
    return `965 ${normalized.substring(3, 7)} ${normalized.substring(7)}`;
  }

  return normalized;
};

export const getCountryCode = (phone) => {
  const normalized = normalizePhone(phone);

  if (!normalized || normalized.length < 8) {
    return null;
  }

  if (normalized.startsWith("965")) return "965";
  if (normalized.startsWith("1") && normalized.length === 11) return "1";
  if (normalized.startsWith("44")) return "44";
  if (normalized.startsWith("971")) return "971";
  if (normalized.startsWith("966")) return "966";

  if (normalized.length >= 10) {
    return normalized.substring(0, Math.min(3, normalized.length - 7));
  }

  return null;
};
