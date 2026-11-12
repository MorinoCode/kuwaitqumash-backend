import test from "node:test";
import assert from "node:assert/strict";
import { transliterateToAscii, toBarcodeSafeCode } from "./transliterate.js";

test("transliterateToAscii converts Arabic letters", () => {
  assert.equal(transliterateToAscii("قطن"), "qtn");
});

test("transliterateToAscii keeps latin text", () => {
  assert.equal(transliterateToAscii("Silk 100"), "Silk 100");
});

test("transliterateToAscii returns an empty string for null", () => {
  assert.equal(transliterateToAscii(null), "");
});

test("toBarcodeSafeCode upper-cases and truncates", () => {
  assert.equal(toBarcodeSafeCode("chiffon", 3), "CHI");
});

test("toBarcodeSafeCode pads short results with X", () => {
  assert.equal(toBarcodeSafeCode("a", 3), "AXX");
});

test("toBarcodeSafeCode falls back to padding for empty labels", () => {
  assert.equal(toBarcodeSafeCode("", 2), "XX");
});
