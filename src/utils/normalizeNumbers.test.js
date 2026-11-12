import test from "node:test";
import assert from "node:assert/strict";
import { normalizeToLatinDigits } from "./normalizeNumbers.js";

test("converts Arabic-Indic digits to Latin", () => {
  assert.equal(normalizeToLatinDigits("١٢٣"), "123");
});

test("converts Persian digits to Latin", () => {
  assert.equal(normalizeToLatinDigits("۴۵۶"), "456");
});

test("leaves Latin digits untouched", () => {
  assert.equal(normalizeToLatinDigits("12-34"), "12-34");
});

test("returns an empty string for null input", () => {
  assert.equal(normalizeToLatinDigits(null), "");
});

test("stringifies non-string values", () => {
  assert.equal(normalizeToLatinDigits(42), "42");
});
