import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const envModule = pathToFileURL(path.join(here, "env.js")).href;

const runEnv = (env) =>
  new Promise((resolve) => {
    const child = spawnSync(
      process.execPath,
      ["-e", `import(${JSON.stringify(envModule)}).then(() => console.log("loaded"))`],
      {
        env: { ...process.env, ...env },
        encoding: "utf8",
      },
    );
    resolve(child);
  });

test("fills optional defaults when the variables are absent", async () => {
  const child = await runEnv({
    SKIP_ENV_VALIDATION: "true",
    DB_HOST: "",
    DB_PORT: "",
    PORT: "",
    MAX_PAGINATION_LIMIT: "",
    CORS_ORIGINS: "",
    REDIS_URL: "",
    NODE_ENV: "",
  });
  assert.match(child.stdout, /loaded/);
  assert.equal(child.stderr.includes("Missing required env vars"), false);
});

test("exits when a required variable is missing and validation is on", async () => {
  const child = await runEnv({
    SKIP_ENV_VALIDATION: "false",
    JWT_SECRET: "",
    DB_NAME: "",
    DB_USER: "",
    DB_PASS: "",
  });
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Missing required env vars/);
});

test("warns when Cloudflare R2 is not configured", async () => {
  const child = await runEnv({
    SKIP_ENV_VALIDATION: "true",
    R2_ACCOUNT_ID: "",
    R2_ENDPOINT: "",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    R2_BUCKET_NAME: "",
    R2_PUBLIC_URL: "",
  });
  assert.match(child.stderr, /Cloudflare R2 is not configured/);
});

test("warns about a partially configured Cloudflare R2", async () => {
  const child = await runEnv({
    SKIP_ENV_VALIDATION: "true",
    R2_ACCOUNT_ID: "demo-account",
    R2_ACCESS_KEY_ID: "",
    R2_SECRET_ACCESS_KEY: "",
    R2_BUCKET_NAME: "",
    R2_PUBLIC_URL: "",
  });
  assert.match(child.stderr, /Cloudflare R2 storage partially configured/);
});
