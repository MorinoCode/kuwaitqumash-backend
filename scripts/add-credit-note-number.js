import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import sequelize from "../src/config/database.js";
import Tenant from "../src/domains/platform/tenant.model.js";
import logger from "../src/utils/logger.js";

async function addCreditNoteNumber() {
  try {
    await sequelize.authenticate();
    logger.info("Connected to database", { component: "add-credit-note-number" });

    const tenants = await Tenant.findAll({ attributes: ["id", "db_schema", "name"] });

    if (tenants.length === 0) {
      logger.info("No tenants found.", { component: "add-credit-note-number" });
      process.exit(0);
    }

    for (const tenant of tenants) {
      const schema = tenant.db_schema;
      if (!schema || !/^[a-zA-Z0-9_]+$/.test(schema)) {
        logger.warn("Skipping invalid schema", { schema });
        continue;
      }

      try {
        const tableName = `"${schema}".refunds`;
        const [colCheck] = await sequelize.query(
          `SELECT 1 FROM information_schema.columns
           WHERE table_schema = '${schema}' AND table_name = 'refunds' AND column_name = 'credit_note_number'`
        );
        if (colCheck && colCheck.length > 0) {
          logger.info("credit_note_number already exists", { schema });
          continue;
        }

        await sequelize.query(`
          ALTER TABLE ${tableName}
          ADD COLUMN IF NOT EXISTS credit_note_number VARCHAR(50) NULL
        `);

        logger.info("Added credit_note_number to refunds", {
          component: "add-credit-note-number",
          schema,
          tenant: tenant.name,
        });
      } catch (err) {
        logger.error("Failed to alter refunds", {
          component: "add-credit-note-number",
          schema,
          error: err?.message,
        });
      }
    }

    logger.info("Done.", { component: "add-credit-note-number" });
    process.exit(0);
  } catch (error) {
    logger.error("Script failed", { component: "add-credit-note-number", error: error?.message });
    process.exit(1);
  }
}

addCreditNoteNumber();
