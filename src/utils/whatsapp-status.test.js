import test from "node:test";
import assert from "node:assert/strict";
import {
  publishWhatsAppStatusCache,
  getSessionStatusFromStore,
  clearWhatsAppStatusCache,
} from "./whatsapp-status.js";

test("publishWhatsAppStatusCache sets ready status for direct branch", async () => {
  const tenantSlug = `tenant-test-${Date.now()}`;
  const branchId = 1;

  await publishWhatsAppStatusCache(tenantSlug, branchId, {
    status: "CONNECTED",
    is_ready: true,
    phone_connected: "+96599990001",
  });

  const res = await getSessionStatusFromStore(tenantSlug, branchId);
  assert.equal(res.status, "CONNECTED");
  assert.equal(res.is_ready, true);
  assert.equal(res.phone_connected, "+96599990001");
  assert.equal(res.is_central_fallback, false);

  await clearWhatsAppStatusCache(tenantSlug, branchId);
});

test("getSessionStatusFromStore falls back to central session when branch has no session", async () => {
  const tenantSlug = `tenant-central-${Date.now()}`;

  // Store owner connects WhatsApp centrally (branch_id: null)
  await publishWhatsAppStatusCache(tenantSlug, null, {
    status: "CONNECTED",
    is_ready: true,
    phone_connected: "+96599990000",
  });

  // Branch 3 has no dedicated connection, queries status
  const branchStatus = await getSessionStatusFromStore(tenantSlug, 3);
  assert.equal(branchStatus.status, "CONNECTED");
  assert.equal(branchStatus.is_ready, true);
  assert.equal(branchStatus.phone_connected, "+96599990000");
  assert.equal(branchStatus.is_central_fallback, true);

  await clearWhatsAppStatusCache(tenantSlug, null);
});

test("getSessionStatusFromStore prefers dedicated branch session over central session", async () => {
  const tenantSlug = `tenant-override-${Date.now()}`;

  // Central number
  await publishWhatsAppStatusCache(tenantSlug, null, {
    status: "CONNECTED",
    is_ready: true,
    phone_connected: "+96599990000",
  });

  // Branch 2 has its own dedicated phone
  await publishWhatsAppStatusCache(tenantSlug, 2, {
    status: "CONNECTED",
    is_ready: true,
    phone_connected: "+96599990002",
  });

  const branchStatus = await getSessionStatusFromStore(tenantSlug, 2);
  assert.equal(branchStatus.status, "CONNECTED");
  assert.equal(branchStatus.is_ready, true);
  assert.equal(branchStatus.phone_connected, "+96599990002");
  assert.equal(branchStatus.is_central_fallback, false);

  await clearWhatsAppStatusCache(tenantSlug, 2);
  await clearWhatsAppStatusCache(tenantSlug, null);
});
