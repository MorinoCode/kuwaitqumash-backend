import test from "node:test";
import assert from "node:assert/strict";
import bcrypt from "bcrypt";
import User from "./user.model.js";
import { changePassword } from "./auth.controller.js";

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: null,
    cookies: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
    cookie(name, value, opts) {
      this.cookies[name] = { value, opts };
      return this;
    },
  };
  return res;
};

test("changePassword passes plaintext new_password to user.update (preventing double-hashing by User beforeUpdate hook)", async () => {
  const originalSchema = User.schema;
  const currentHash = await bcrypt.hash("OldSecret123!", 4);
  let updatePayload = null;

  const mockUser = {
    id: 42,
    password: currentHash,
    token_version: 2,
    async update(payload) {
      updatePayload = payload;
      return this;
    },
  };

  User.schema = () => ({
    findByPk: async () => mockUser,
  });

  try {
    const req = {
      tenant: { db_schema: "tenant_test", slug: "test-store" },
      user: { id: 42 },
      body: {
        current_password: "OldSecret123!",
        new_password: "NewSecret456!",
      },
    };
    const res = makeRes();

    await changePassword(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.body?.success, true);
    assert.ok(updatePayload, "Expected user.update to be called");
    assert.equal(
      updatePayload.password,
      "NewSecret456!",
      "Must pass plaintext password so Sequelize beforeUpdate hashes it exactly once",
    );
    assert.equal(updatePayload.token_version, 3);
    assert.ok(res.cookies.token?.value, "Should issue a refreshed auth cookie");
  } finally {
    User.schema = originalSchema;
  }
});

test("changePassword rejects wrong current_password with 400", async () => {
  const originalSchema = User.schema;
  const currentHash = await bcrypt.hash("RealPassword123!", 4);
  let updated = false;

  User.schema = () => ({
    findByPk: async () => ({
      id: 42,
      password: currentHash,
      token_version: 0,
      async update() {
        updated = true;
      },
    }),
  });

  try {
    const req = {
      tenant: { db_schema: "tenant_test", slug: "test-store" },
      user: { id: 42 },
      body: {
        current_password: "WrongPassword!",
        new_password: "NewSecret456!",
      },
    };
    const res = makeRes();

    await changePassword(req, res);

    assert.equal(res.statusCode, 400);
    assert.equal(updated, false);
  } finally {
    User.schema = originalSchema;
  }
});
