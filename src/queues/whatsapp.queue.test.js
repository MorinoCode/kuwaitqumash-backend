import test from "node:test";
import assert from "node:assert/strict";
import {
  computeBulkScheduleOffsets,
  getBulkQuotaKey,
  getKuwaitDateString,
  getKuwaitHour,
  reserveDailyBulkQuota,
  releaseDailyBulkQuota,
  snapToKuwaitAllowedWindow,
} from "./whatsapp.queue.js";

test("getKuwaitDateString uses Asia/Kuwait UTC+3 boundary", () => {
  // 2026-05-01 22:30 UTC is 2026-05-02 01:30 Asia/Kuwait
  const utcMs = Date.UTC(2026, 4, 1, 22, 30, 0);
  assert.equal(getKuwaitDateString(utcMs), "2026-05-02");
  assert.equal(getKuwaitHour(utcMs), 1);
  assert.equal(
    getBulkQuotaKey("al-noor", utcMs),
    "wa:bulk:al-noor:2026-05-02",
  );
});

test("snapToKuwaitAllowedWindow moves early morning and late night into 09:00-22:00", () => {
  // 04:00 Kuwait = 01:00 UTC
  const earlyKuwaitUtc = Date.UTC(2026, 4, 2, 1, 0, 0);
  const snappedEarly = snapToKuwaitAllowedWindow(earlyKuwaitUtc, {
    startHour: 9,
    endHour: 22,
  });
  assert.equal(getKuwaitHour(snappedEarly), 9);

  // 23:00 Kuwait = 20:00 UTC -> next day 09:00 Kuwait
  const lateKuwaitUtc = Date.UTC(2026, 4, 2, 20, 0, 0);
  const snappedLate = snapToKuwaitAllowedWindow(lateKuwaitUtc, {
    startHour: 9,
    endHour: 22,
  });
  assert.equal(getKuwaitHour(snappedLate), 9);
  assert.equal(getKuwaitDateString(snappedLate), "2026-05-03");
});

test("computeBulkScheduleOffsets applies 20-45s jitter and 3-5m pause every 20 messages", () => {
  // 10:00 Kuwait = 07:00 UTC, well within 09:00-22:00 window
  const nowSpy = Date.now;
  const fixedStart = Date.UTC(2026, 4, 2, 7, 0, 0);
  Date.now = () => fixedStart;
  try {
    // randomFn = 0 gives exact lower bounds (20s gap, +180s pause at i=20)
    const { delaysMs } = computeBulkScheduleOffsets(
      22,
      fixedStart,
      () => 0,
      { startHour: 9, endHour: 22 },
    );
    assert.equal(delaysMs.length, 22);
    assert.equal(delaysMs[0], 0);
    assert.equal(delaysMs[1] - delaysMs[0], 20_000);
    // At index 20: 20s gap + 180s cooldown = 200s
    assert.equal(delaysMs[20] - delaysMs[19], 200_000);
  } finally {
    Date.now = nowSpy;
  }
});

test("reserveDailyBulkQuota enforces hard daily ceiling without rolling overflow", async () => {
  const slug = `test-store-${Date.now()}`;
  const first = await reserveDailyBulkQuota(slug, 80, 100);
  assert.equal(first.allowed, true);
  assert.equal(first.used, 80);
  assert.equal(first.remaining, 20);

  const overflow = await reserveDailyBulkQuota(slug, 25, 100);
  assert.equal(overflow.allowed, false);
  assert.equal(overflow.used, 80);
  assert.equal(overflow.remaining, 20);

  await releaseDailyBulkQuota(slug, 80);
});

test("acquireBulkSlotLock and releaseBulkSlotLock synchronize concurrent slot access", async () => {
  const slug = `lock-store-${Date.now()}`;
  const { acquireBulkSlotLock, releaseBulkSlotLock } = await import("./whatsapp.queue.js");

  const token1 = await acquireBulkSlotLock(slug, 5000);
  assert.ok(token1);

  // Attempting to acquire again immediately should time out
  await assert.rejects(
    () => acquireBulkSlotLock(slug, 5000, 200),
    /Timeout acquiring WhatsApp bulk scheduling lock/,
  );

  await releaseBulkSlotLock(slug, token1);

  // After release, acquisition succeeds immediately
  const token2 = await acquireBulkSlotLock(slug, 5000);
  assert.ok(token2);
  await releaseBulkSlotLock(slug, token2);
});

test("late night quiet hours schedule debits quota on delivery date (next day)", async () => {
  // 23:30 Kuwait time = 20:30 UTC
  const lateNightMs = Date.UTC(2026, 4, 2, 20, 30, 0);
  const scheduledMs = snapToKuwaitAllowedWindow(lateNightMs, {
    startHour: 9,
    endHour: 22,
  });

  // Delivery snapped to next morning 09:00 Kuwait
  assert.equal(getKuwaitHour(scheduledMs), 9);
  assert.equal(getKuwaitDateString(scheduledMs), "2026-05-03");

  const slug = `quota-store-${Date.now()}`;
  const quota = await reserveDailyBulkQuota(slug, 50, 100, scheduledMs);
  assert.equal(quota.allowed, true);
  assert.equal(quota.key, `wa:bulk:${slug}:2026-05-03`);

  await releaseDailyBulkQuota(slug, 50, scheduledMs);
});

