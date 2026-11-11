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

const sequelize = new Sequelize(dbName, dbUser, dbPassword, {
  host: dbHost,
  dialect: "postgres",
  logging: false,
  pool: {
    max: 20,
    min: 5,
    acquire: 30000,
    idle: 10000,
    evict: 1000,
  },

  dialectOptions: {

    prepare: true,

    connectTimeout: 10000,

    statement_timeout: 30000,
    idle_in_transaction_session_timeout: 60000
  },
});

sequelize.authenticate().catch(err => {
  console.error("FATAL: Database authentication failed. Check credentials.");
  console.error(err.message);
  if (process.env.NODE_ENV !== "test") {
    process.exit(1);
  }
});

export default sequelize;
