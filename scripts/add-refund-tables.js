import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, "../.env") });

import sequelize from "../src/config/database.js";
import Tenant from "../src/domains/platform/tenant.model.js";
import Refund from "../src/domains/sales/refund.model.js";
import RefundItem from "../src/domains/sales/refund-item.model.js";
import RefundPayment from "../src/domains/sales/refund-payment.model.js";
import logger from "../src/utils/logger.js";

async function addRefundTables() {
  try {
    await sequelize.authenticate();
    logger.info("Connected to database", { component: "add-refund-tables" });

    const tenants = await Tenant.findAll({ attributes: ["id", "db_schema", "name"] });

    if (tenants.length === 0) {
      logger.info("No tenants found.", { component: "add-refund-tables" });
      process.exit(0);
    }

    for (const tenant of tenants) {
      const schema = tenant.db_schema;
      if (!schema || !/^[a-zA-Z0-9_]+$/.test(schema)) {
        logger.warn("Skipping invalid schema", { schema });
        continue;
      }

      try {
        await sequelize.query(`SET search_path TO "${schema}", public`);

        await Refund.schema(schema).sync({ alter: false });
        await RefundItem.schema(schema).sync({ alter: false });
        await RefundPayment.schema(schema).sync({ alter: false });

        logger.info("Refund tables ready", {
          component: "add-refund-tables",
          schema,
          tenant: tenant.name,
        });
      } catch (err) {
        logger.error("Failed to sync refund tables", {
          component: "add-refund-tables",
          schema,
          error: err?.message,
        });
      }
    }

    await sequelize.query("SET search_path TO public");
    logger.info("Done.", { component: "add-refund-tables" });
    process.exit(0);
  } catch (error) {
    logger.error("Script failed", { component: "add-refund-tables", error: error?.message });
    process.exit(1);
  }
}

addRefundTables();
