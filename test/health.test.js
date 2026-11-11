import { describe, it, after } from "node:test";
import assert from "node:assert";
import request from "supertest";
import { app } from "../src/app.js";
import sequelize from "../src/config/database.js";

describe("GET /health", () => {
  after(async () => {
    const closeMs = 3000;
    await Promise.race([
      sequelize.close(),
      new Promise((r) => setTimeout(r, closeMs)),
    ]).catch(() => {});
    process.exit(0);
  });

  it("returns 200 or 503 with status, checks, and timestamp", async () => {
    const res = await request(app).get("/health");
    assert.ok([200, 503].includes(res.status), "expected 200 or 503");
    assert.ok(
      ["ok", "degraded"].includes(res.body?.status),
      "expected status ok or degraded"
    );
    assert.ok(typeof res.body?.checks === "object", "expected checks object");
    assert.strictEqual(
      typeof res.body?.timestamp,
      "string",
      "expected timestamp string"
    );
  });

  it("returns x-request-id header", async () => {
    const res = await request(app).get("/health");
    assert.ok(res.headers["x-request-id"], "missing x-request-id");
  });
});
