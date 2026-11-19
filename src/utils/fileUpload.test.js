import test from "node:test";
import assert from "node:assert/strict";
import {
  buildObjectKey,
  deleteStoreFolder,
  extractObjectKeyFromUrl,
  getR2Config,
  saveImage,
} from "./fileUpload.js";

test("buildObjectKey sanitizes and joins segments", () => {
  assert.equal(
    buildObjectKey(["kuwaitqumash", "al-noor", "inventory", "silk 2026"]),
    "kuwaitqumash/al-noor/inventory/silk_2026",
  );
});

test("extractObjectKeyFromUrl strips R2_PUBLIC_URL prefix", () => {
  const prevUrl = process.env.R2_PUBLIC_URL;
  process.env.R2_PUBLIC_URL = "https://cdn.example.com";
  try {
    assert.equal(
      extractObjectKeyFromUrl("https://cdn.example.com/kuwaitqumash/inv/a.webp"),
      "kuwaitqumash/inv/a.webp",
    );
  } finally {
    if (prevUrl === undefined) delete process.env.R2_PUBLIC_URL;
    else process.env.R2_PUBLIC_URL = prevUrl;
  }
});

test("getR2Config reports unconfigured when variables are absent", () => {
  const saved = {
    R2_ACCOUNT_ID: process.env.R2_ACCOUNT_ID,
    R2_ENDPOINT: process.env.R2_ENDPOINT,
    R2_ACCESS_KEY_ID: process.env.R2_ACCESS_KEY_ID,
    R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY,
    R2_BUCKET_NAME: process.env.R2_BUCKET_NAME,
    R2_PUBLIC_URL: process.env.R2_PUBLIC_URL,
  };
  delete process.env.R2_ACCOUNT_ID;
  delete process.env.R2_ENDPOINT;
  delete process.env.R2_ACCESS_KEY_ID;
  delete process.env.R2_SECRET_ACCESS_KEY;
  delete process.env.R2_BUCKET_NAME;
  delete process.env.R2_PUBLIC_URL;
  try {
    assert.equal(getR2Config().configured, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});

test("saveImage returns null cleanly when file is null", async () => {
  assert.equal(await saveImage(null), null);
});

test("deleteStoreFolder handles missing store or unconfigured R2 cleanly", async () => {
  await assert.doesNotReject(async () => {
    await deleteStoreFolder(null);
    await deleteStoreFolder("test-tenant");
  });
});


