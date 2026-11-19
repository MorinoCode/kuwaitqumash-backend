import "../src/config/env.js";
import sequelize from "../src/config/database.js";
import logger from "../src/utils/logger.js";
import { ensureTenantMigrations } from "../src/utils/schema.manager.js";

import Tenant from "../src/domains/platform/tenant.model.js";
import ContactMessage from "../src/domains/platform/contact-message.model.js";
import WhatsAppConfig from "../src/domains/platform/whatsapp.config.model.js";
import Branch from "../src/domains/store/branch.model.js";
import User from "../src/domains/auth/user.model.js";
import Customer from "../src/domains/customers/customer.model.js";
import InventoryItem from "../src/domains/inventory/item.model.js";
import CustomInventoryOption from "../src/domains/inventory/custom-option.model.js";
import Invoice from "../src/domains/sales/invoice.model.js";
import InvoiceItem from "../src/domains/sales/invoice-item.model.js";
import InvoicePayment from "../src/domains/sales/payment.model.js";
import Refund from "../src/domains/sales/refund.model.js";
import RefundItem from "../src/domains/sales/refund-item.model.js";
import RefundPayment from "../src/domains/sales/refund-payment.model.js";

const REQUIRED_TABLES = [
  "branches",
  "users",
  "customers",
  "inventory_items",
  "custom_inventory_options",
  "invoices",
  "invoice_items",
  "invoice_payments",
  "refunds",
  "refund_items",
  "refund_payments",
];

const syncTenantTables = async (schema) => {
  await sequelize.query(`SET search_path TO "${schema}", public`);
  try {
    await Branch.schema(schema).sync({ alter: false });
    await User.schema(schema).sync({ alter: false });
    await Customer.schema(schema).sync({ alter: false });
    await InventoryItem.schema(schema).sync({ alter: false });
    await CustomInventoryOption.schema(schema).sync({ alter: false });
    await Invoice.schema(schema).sync({ alter: false });
    await InvoiceItem.schema(schema).sync({ alter: false });
    await InvoicePayment.schema(schema).sync({ alter: false });
    await Refund.schema(schema).sync({ alter: false });
    await RefundItem.schema(schema).sync({ alter: false });
    await RefundPayment.schema(schema).sync({ alter: false });
  } finally {
    await sequelize.query("SET search_path TO public");
  }
};

const run = async () => {
  await sequelize.authenticate();
  logger.info("Connected to PostgreSQL for tenant migrations", {
    component: "migrate-tenants",
  });

  await Tenant.sync({ alter: false });
  await sequelize.query(
    `ALTER TABLE public.tenants
     ADD COLUMN IF NOT EXISTS subscription_expires_at TIMESTAMP WITH TIME ZONE;`
  );
  await WhatsAppConfig.sync({ alter: false });
  await ContactMessage.sync({ alter: false });

  const tenants = await Tenant.findAll({ order: [["id", "ASC"]] });
  logger.info("Running tenant migrations", {
    component: "migrate-tenants",
    tenantCount: tenants.length,
  });

  for (const tenant of tenants) {
    const schema = tenant.db_schema;
    if (!/^[a-zA-Z0-9_]+$/.test(schema)) {
      logger.warn("Skipping invalid tenant schema", {
        component: "migrate-tenants",
        tenantId: tenant.id,
        schema,
      });
      continue;
    }

    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);

    const [tableCheck] = await sequelize.query(
      `SELECT COUNT(*)::int AS table_count
       FROM information_schema.tables
       WHERE table_schema = $1
       AND table_name = ANY($2::text[])`,
      {
        bind: [schema, REQUIRED_TABLES],
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const existingCount = tableCheck?.table_count || 0;
    if (existingCount < REQUIRED_TABLES.length) {
      logger.info("Syncing missing tables for tenant", {
        component: "migrate-tenants",
        schema,
        existingCount,
        required: REQUIRED_TABLES.length,
      });
      await syncTenantTables(schema);
    }

    await ensureTenantMigrations(schema);
  }

  logger.info("All tenant migrations completed successfully.", {
    component: "migrate-tenants",
  });
};

run()
  .catch((error) => {
    logger.error("Tenant migration failed", {
      component: "migrate-tenants",
      error: error?.message,
      stack: error?.stack,
    });
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });

