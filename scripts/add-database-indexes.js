import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const envPath = path.resolve(__dirname, "../.env");
dotenv.config({ path: envPath });

import sequelize from "../src/config/database.js";
import Tenant from "../src/domains/platform/tenant.model.js";
import logger from "../src/utils/logger.js";
import { createIndexesForSchema } from "../src/utils/index-helper.js";

async function addIndexes() {
  try {

    logger.info("Checking database configuration", {
      component: "add-database-indexes",
      hasDBName: !!process.env.DB_NAME,
      hasDBUser: !!process.env.DB_USER,
      hasDBPass: !!process.env.DB_PASS,
      hasDBHost: !!process.env.DB_HOST,
      dbPasswordType: typeof process.env.DB_PASS,
      dbPasswordValue: process.env.DB_PASS ? "***" : "undefined",
      envPath: envPath,
    });

    logger.info("Connecting to database", {
      component: "add-database-indexes",
    });
    await sequelize.authenticate();
    logger.info("Connected", { component: "add-database-indexes" });

    await sequelize.query("SET search_path TO public");
    const tenants = await Tenant.findAll();

    if (tenants.length === 0) {
      logger.info(
        "No tenants found. Create tenants first (e.g. npm run db:seed).",
        {
          component: "add-database-indexes",
        },
      );
      process.exit(0);
    }

    logger.info("Adding indexes", {
      component: "add-database-indexes",
      tenantCount: tenants.length,
    });

    for (const tenant of tenants) {
      const schema = tenant.db_schema;
      if (!/^[a-zA-Z0-9_]+$/.test(schema)) {
        logger.warn("Skipping invalid schema", {
          component: "add-database-indexes",
          schema,
        });
        continue;
      }

      try {
        logger.info("Creating indexes for tenant", {
          component: "add-database-indexes",
          schema,
          tenantName: tenant.name,
        });

        const result = await createIndexesForSchema(schema);

        logger.info("Indexes created for tenant", {
          component: "add-database-indexes",
          schema,
          tenantName: tenant.name,
          created: result.created,
          skipped: result.skipped,
          failed: result.failed,
        });
      } catch (error) {
        logger.error("Failed to create indexes for tenant", {
          component: "add-database-indexes",
          schema,
          tenantName: tenant.name,
          error: error?.message,
        });

      }
    }

    logger.info("Database indexes added successfully", {
      component: "add-database-indexes",
    });
  } catch (err) {
    logger.error("Error adding indexes", {
      component: "add-database-indexes",
      error: err?.message,
      stack: err?.stack,
    });
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

addIndexes();
