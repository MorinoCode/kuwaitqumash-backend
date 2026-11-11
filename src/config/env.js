import dotenv from "dotenv";

dotenv.config();

const REQUIRED = [
  "JWT_SECRET",
  "DB_NAME",
  "DB_USER",
  "DB_PASS",
  "CLOUDINARY_CLOUD_NAME",
  "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET",
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

if (
  process.env.CLOUDINARY_CLOUD_NAME &&
  (!process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET)
) {

  console.warn(
    "[env] Warning: Cloudinary cloud name provided but API key/secret missing."
  );
}
