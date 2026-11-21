import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { validateImageContent } from "./upload.middleware.js";

const tempDir = "public/temp";

test("validateImageContent: passes cleanly when no files are uploaded", async () => {
  let nextCalled = false;
  await validateImageContent({}, {}, () => {
    nextCalled = true;
  });
  assert.equal(nextCalled, true);
});

test("validateImageContent: unlinks ALL files in request if one is invalid", async () => {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  // File 1: valid PNG signature
  const file1Path = path.join(tempDir, `test-valid-${Date.now()}.png`);
  fs.writeFileSync(file1Path, Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));

  // File 2: invalid PNG signature (corrupted/fake)
  const file2Path = path.join(tempDir, `test-invalid-${Date.now()}.png`);
  fs.writeFileSync(file2Path, Buffer.from([0x00, 0x01, 0x02, 0x03]));

  const req = {
    files: [
      { path: file1Path, mimetype: "image/png" },
      { path: file2Path, mimetype: "image/png" },
    ],
  };

  let resStatus = null;
  let resBody = null;
  const res = {
    status(s) {
      resStatus = s;
      return this;
    },
    json(b) {
      resBody = b;
      return this;
    },
  };

  await validateImageContent(req, res, () => {
    assert.fail("next() should not be called when a file has invalid content");
  });

  assert.equal(resStatus, 400);
  assert.equal(resBody?.message, "Invalid file content. File does not match its declared type.");

  // CRITICAL CHECK (Bug #10): BOTH files must be unlinked from temp, not just the failing one
  assert.equal(fs.existsSync(file1Path), false, "Valid file must be unlinked to prevent temp leakage");
  assert.equal(fs.existsSync(file2Path), false, "Invalid file must be unlinked");
});

test("validateImageContent: validates valid WebP header asynchronously", async () => {
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const webpPath = path.join(tempDir, `test-valid-${Date.now()}.webp`);
  const webpHeader = Buffer.from([
    0x52, 0x49, 0x46, 0x46, // RIFF
    0x24, 0x00, 0x00, 0x00,
    0x57, 0x45, 0x42, 0x50, // WEBP
    0x56, 0x50, 0x38, 0x20,
  ]);
  fs.writeFileSync(webpPath, webpHeader);

  let nextCalled = false;
  try {
    await validateImageContent(
      { file: { path: webpPath, mimetype: "image/webp" } },
      {},
      () => {
        nextCalled = true;
      },
    );
    assert.equal(nextCalled, true);
  } finally {
    if (fs.existsSync(webpPath)) fs.unlinkSync(webpPath);
  }
});

