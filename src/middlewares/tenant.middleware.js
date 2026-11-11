import Tenant from "../domains/platform/tenant.model.js";
import sequelize from "../config/database.js";
import logger from "../utils/logger.js";
import Branch from "../domains/store/branch.model.js";
import User from "../domains/auth/user.model.js";
import Customer from "../domains/customers/customer.model.js";
import InventoryItem from "../domains/inventory/item.model.js";
import Invoice from "../domains/sales/invoice.model.js";
import InvoiceItem from "../domains/sales/invoice-item.model.js";
import InvoicePayment from "../domains/sales/payment.model.js";
import CustomInventoryOption from "../domains/inventory/custom-option.model.js";
import Refund from "../domains/sales/refund.model.js";
import RefundItem from "../domains/sales/refund-item.model.js";
import RefundPayment from "../domains/sales/refund-payment.model.js";

const syncedTenants = new Set();
const MAX_CACHE_SIZE = 1000;

const syncInProgress = new Map();

const ensureTenantTables = async (schemaName) => {

  if (syncedTenants.has(schemaName)) {
    return;
  }

  if (syncInProgress.has(schemaName)) {
    return syncInProgress.get(schemaName);
  }

  const syncWork = (async () => {
    try {

    const [tableCheck] = await sequelize.query(
      `SELECT COUNT(*)::int as table_count
       FROM information_schema.tables
       WHERE table_schema = $1
       AND table_name IN ('branches', 'users', 'customers', 'inventory_items')`,
      {
        bind: [schemaName],
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const existingTableCount = tableCheck?.[0]?.table_count || 0;

    const [refundCheck] = await sequelize.query(
      `SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = $1 AND table_name = 'refunds'
      ) AS exists`,
      { bind: [schemaName], type: sequelize.QueryTypes.SELECT }
    );
    const hasRefundTables = refundCheck?.[0]?.exists === true;

    if (existingTableCount < 4 || !hasRefundTables) {

      logger.info("Lazy sync: Creating missing tables for tenant", {
        component: "tenant.middleware",
        schema: schemaName,
        existingTables: existingTableCount,
        hasRefundTables,
      });

      await Branch.schema(schemaName).sync({ alter: false });
      await User.schema(schemaName).sync({ alter: false });
      await Customer.schema(schemaName).sync({ alter: false });
      await InventoryItem.schema(schemaName).sync({ alter: false });

      try {
        await CustomInventoryOption.schema(schemaName).sync({ alter: false });
      } catch (customOptionError) {
        void customOptionError;

      }

      await Invoice.schema(schemaName).sync({ alter: false });
      await InvoiceItem.schema(schemaName).sync({ alter: false });
      await InvoicePayment.schema(schemaName).sync({ alter: false });
      await Refund.schema(schemaName).sync({ alter: false });
      await RefundItem.schema(schemaName).sync({ alter: false });
      await RefundPayment.schema(schemaName).sync({ alter: false });

      logger.info("Lazy sync completed for tenant", {
        component: "tenant.middleware",
        schema: schemaName,
      });
    }

    if (syncedTenants.size >= MAX_CACHE_SIZE) {

      const firstItem = syncedTenants.values().next().value;
      syncedTenants.delete(firstItem);
    }
    syncedTenants.add(schemaName);
  } catch (syncError) {
    logger.warn("Lazy sync failed, continuing anyway", {
      component: "tenant.middleware",
      schema: schemaName,
      error: syncError.message,
    });

  }
  })();

  syncInProgress.set(schemaName, syncWork);
  try {
    await syncWork;
  } finally {
    syncInProgress.delete(schemaName);
  }
};

export const resolveTenant = async (req, res, next) => {

  const tenantSlug = req.headers["x-tenant-id"];

  if (!tenantSlug) {
    return res
      .status(400)
      .json({ message: "Tenant ID header (x-tenant-id) is missing." });
  }

  try {

    const tenant = await Tenant.findOne({
      where: { slug: tenantSlug, subscription_status: "active" },
    });

    if (!tenant) {
      return res.status(404).json({ message: "Store not found or inactive." });
    }

    const schemaName = tenant.db_schema;
    if (!/^[a-zA-Z0-9_]+$/.test(schemaName)) {
      throw new Error("Invalid schema name detected.");
    }

    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);

    await ensureTenantTables(schemaName);

    req.tenant = tenant;
    next();
  } catch (error) {
    logger.error("Tenant resolution error", {
      component: "tenant.middleware",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Internal Server Error during tenant resolution." });
  }
};
