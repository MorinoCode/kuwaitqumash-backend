import { Sequelize } from "sequelize";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const envPath = path.resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

const dbName = process.env.DB_NAME ? String(process.env.DB_NAME) : "";
const dbUser = process.env.DB_USER ? String(process.env.DB_USER) : "";
const dbPassword =
  process.env.DB_PASS !== undefined && process.env.DB_PASS !== null
    ? String(process.env.DB_PASS)
    : "";
const dbHost = process.env.DB_HOST ? String(process.env.DB_HOST) : "localhost";
const dbPort = process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432;

const poolMax = Math.max(1, Number(process.env.DB_POOL_MAX) || 20);
const configuredPoolMin = Math.min(
  poolMax,
  Math.max(0, Number(process.env.DB_POOL_MIN ?? 5)),
);
// Keep idle test pools at 0 so unit test suites exit cleanly without lingering sockets.
const poolMin = process.env.NODE_ENV === "test" ? 0 : configuredPoolMin;

const sequelize = new Sequelize(dbName, dbUser, dbPassword, {
  host: dbHost,
  port: dbPort,
  dialect: "postgres",
  logging: false,
  pool: {
    max: poolMax,
    min: poolMin,
    acquire: Number(process.env.DB_POOL_ACQUIRE_MS) || 30000,
    idle: Number(process.env.DB_POOL_IDLE_MS) || 10000,
    evict: 1000,
  },

  dialectOptions: {

    prepare: true,

    connectTimeout: 10000,

    statement_timeout: Number(process.env.DB_STATEMENT_TIMEOUT_MS) || 30000,
    idle_in_transaction_session_timeout: 60000
  },
});

export default sequelize;
