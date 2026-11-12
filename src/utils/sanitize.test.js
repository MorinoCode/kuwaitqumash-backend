import test from "node:test";
import assert from "node:assert/strict";
import {
  sanitizeString,
  sanitizeName,
  sanitizePhone,
  sanitizeNumber,
  sanitizeInteger,
  sanitizeObject,
} from "./sanitize.js";

test("sanitizeString strips HTML tags", () => {
  assert.equal(sanitizeString("<b>Cotton</b>"), "Cotton");
});

test("sanitizeString trims and respects maxLength", () => {
  assert.equal(sanitizeString("  abcd  ", 2), "ab");
});

test("sanitizeString returns an empty string for non strings", () => {
  assert.equal(sanitizeString(null), "");
});

test("sanitizeName keeps the text", () => {
  assert.equal(sanitizeName("Ahmed"), "Ahmed");
});

test("sanitizePhone keeps digits, plus, spaces and dashes", () => {
  assert.equal(sanitizePhone("+965 9000-123"), "+965 9000-123");
});

test("sanitizeNumber parses Persian digits", () => {
  assert.equal(sanitizeNumber("۱۲.۵"), 12.5);
});

test("sanitizeNumber returns null for junk", () => {
  assert.equal(sanitizeNumber("abc"), null);
});

test("sanitizeInteger floors a number", () => {
  assert.equal(sanitizeInteger(4.9), 4);
});

test("sanitizeObject applies the declared sanitizers only", () => {
  const result = sanitizeObject(
    { name: "<i>Ali</i>", amount: "۲۵", untouched: "x" },
    { name: { type: "name" }, amount: { type: "number" } },
  );
  assert.equal(result.name, "Ali");
  assert.equal(result.amount, 25);
  assert.equal(result.untouched, "x");
});
