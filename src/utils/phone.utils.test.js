import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePhone,
  isValidPhoneFormat,
  formatPhoneForWhatsApp,
  formatPhoneForDisplay,
  getCountryCode,
} from "./phone.utils.js";

test("normalizePhone keeps digits only", () => {
  assert.equal(normalizePhone("+965 9000-1234"), "96590001234");
});

test("normalizePhone strips the leading 00", () => {
  assert.equal(normalizePhone("0096590001234"), "96590001234");
});

test("normalizePhone converts Arabic digits", () => {
  assert.equal(normalizePhone("٩٦٥٩٠٠٠١٢٣٤"), "96590001234");
});

test("normalizePhone returns an empty string for empty input", () => {
  assert.equal(normalizePhone(""), "");
});

test("isValidPhoneFormat accepts a Kuwaiti mobile", () => {
  assert.equal(isValidPhoneFormat("96590001234"), true);
});

test("isValidPhoneFormat rejects short and empty numbers", () => {
  assert.equal(isValidPhoneFormat("123"), false);
  assert.equal(isValidPhoneFormat(""), false);
});

test("formatPhoneForWhatsApp appends the WhatsApp domain", () => {
  assert.equal(formatPhoneForWhatsApp("96590001234"), "96590001234@s.whatsapp.net");
});

test("formatPhoneForWhatsApp returns null for an unusable number", () => {
  assert.equal(formatPhoneForWhatsApp("12"), null);
});

test("formatPhoneForDisplay groups a Kuwaiti number", () => {
  assert.equal(formatPhoneForDisplay("96590001234"), "965 9000 1234");
});

test("getCountryCode detects Kuwait and the US", () => {
  assert.equal(getCountryCode("96590001234"), "965");
  assert.equal(getCountryCode("12025550123"), "1");
  assert.equal(getCountryCode("12"), null);
});
