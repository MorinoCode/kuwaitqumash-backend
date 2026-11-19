import dotenv from "dotenv";

dotenv.config();

const REQUIRED = [
  "JWT_SECRET",
  "DB_NAME",
  "DB_USER",
  "DB_PASS",
];

const OPTIONAL_WITH_DEFAULTS = {
  DB_HOST: "localhost",
  DB_PORT: "5432",
  PORT: "5000",
  NODE_ENV: "development",
  MAX_PAGINATION_LIMIT: "200",
  CORS_ORIGINS: "http://localhost:5173,http://localhost:3000",
  REDIS_URL: "redis://localhost:6379",
};

const skipValidation =
  process.env.SKIP_ENV_VALIDATION === "true" ||
  process.env.SKIP_ENV_VALIDATION === "1";

if (!skipValidation) {
  const missing = REQUIRED.filter((k) => !process.env[k]?.trim());

  if (missing.length > 0) {

    console.error("[env] Missing required env vars:", missing.join(", "));

    console.error("[env] Add them to .env and restart.");
    process.exit(1);
  }
}

for (const [key, defaultValue] of Object.entries(OPTIONAL_WITH_DEFAULTS)) {
  if (!process.env[key]) {
    process.env[key] = defaultValue;
  }
}

const r2Endpoint = process.env.R2_ENDPOINT || process.env.R2_ACCOUNT_ID;
const r2Values = [
  r2Endpoint,
  process.env.R2_ACCESS_KEY_ID,
  process.env.R2_SECRET_ACCESS_KEY,
  process.env.R2_BUCKET_NAME,
  process.env.R2_PUBLIC_URL,
];
const hasAnyR2 = r2Values.some(Boolean);
const hasAllR2 = r2Values.every(Boolean);

if (hasAnyR2 && !hasAllR2) {
  console.warn(
    "[env] Warning: Cloudflare R2 storage partially configured (missing endpoint/account, key, bucket, or public URL)."
  );
}

if (!hasAnyR2) {
  console.warn("[env] Cloudflare R2 is not configured: image uploads are disabled.");
}
