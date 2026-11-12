import test from "node:test";
import assert from "node:assert/strict";
import {
  createBranchBody,
  updateBranchBody,
  createStaffBody,
  updateStaffBody,
} from "./management.schemas.js";

test("createBranchBody defaults optional fields to empty strings", () => {
  const parsed = createBranchBody.parse({ name: "Salmiya" });
  assert.equal(parsed.location, "");
  assert.equal(parsed.phone, "");
});

test("createBranchBody requires a name", () => {
  assert.equal(createBranchBody.safeParse({}).success, false);
});

test("updateBranchBody converts whatsapp flags", () => {
  const parsed = updateBranchBody.parse({
    whatsapp_invoice_enabled: "true",
    whatsapp_invoice_to_store_enabled: true,
  });
  assert.equal(parsed.whatsapp_invoice_enabled, true);
  assert.equal(parsed.whatsapp_invoice_to_store_enabled, true);
});

test("updateBranchBody treats any other value as false", () => {
  const parsed = updateBranchBody.parse({ whatsapp_invoice_enabled: "false" });
  assert.equal(parsed.whatsapp_invoice_enabled, false);
});

test("updateStaffBody leaves flags undefined when absent", () => {
  const parsed = updateStaffBody.parse({ full_name: "Noura" });
  assert.equal(parsed.is_active, undefined);
});

const staff = {
  full_name: "Noura",
  username: "noura.s_1",
  password: "secret1",
  role: "sales_man",
  branch_id: 2,
};

test("createStaffBody accepts a valid sales person", () => {
  assert.equal(createStaffBody.safeParse(staff).success, true);
});

test("createStaffBody coerces branch_id", () => {
  const parsed = createStaffBody.parse({ ...staff, branch_id: "7" });
  assert.equal(parsed.branch_id, 7);
});

test("createStaffBody rejects invalid usernames", () => {
  assert.equal(
    createStaffBody.safeParse({ ...staff, username: "bad name!" }).success,
    false,
  );
});

test("createStaffBody restricts roles", () => {
  assert.equal(
    createStaffBody.safeParse({ ...staff, role: "admin" }).success,
    false,
  );
});

test("createStaffBody requires a positive branch", () => {
  assert.equal(
    createStaffBody.safeParse({ ...staff, branch_id: 0 }).success,
    false,
  );
});
