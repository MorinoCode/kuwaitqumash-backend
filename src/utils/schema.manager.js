import sequelize from "../config/database.js";

import logger from "./logger.js";
import User from "../domains/auth/user.model.js";
import Branch from "../domains/store/branch.model.js";
import InventoryItem from "../domains/inventory/item.model.js";
import CustomInventoryOption from "../domains/inventory/custom-option.model.js";
import Customer from "../domains/customers/customer.model.js";
import Invoice from "../domains/sales/invoice.model.js";
import InvoiceItem from "../domains/sales/invoice-item.model.js";
import InvoicePayment from "../domains/sales/payment.model.js";
import Refund from "../domains/sales/refund.model.js";
import RefundItem from "../domains/sales/refund-item.model.js";
import RefundPayment from "../domains/sales/refund-payment.model.js";
import {
  createIndexesForSchema,
  createSearchIndexesForSchema,
} from "./index-helper.js";

export const createTenantSchema = async (tenantData, adminUserData) => {
  const schemaName = tenantData.db_schema;
  const t = await sequelize.transaction();

  try {
    // 1. Create Schema
    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`, {
      transaction: t,
    });

    // 2. Set search_path so all syncs (including CustomInventoryOption) create tables in tenant schema
    await sequelize.query(`SET LOCAL search_path TO "${schemaName}", public`, {
      transaction: t,
    });

    // 3. Sync Tables using .schema() method
    await Branch.schema(schemaName).sync({ force: true, transaction: t });
    await User.schema(schemaName).sync({ force: true, transaction: t });

    await InventoryItem.schema(schemaName).sync({
      force: true,
      transaction: t,
    });
    await CustomInventoryOption.schema(schemaName).sync({
      force: true,
      transaction: t,
    });
    await Customer.schema(schemaName).sync({ force: true, transaction: t });
    await Invoice.schema(schemaName).sync({ force: true, transaction: t });
    await InvoiceItem.schema(schemaName).sync({ force: true, transaction: t });
    await InvoicePayment.schema(schemaName).sync({
      force: true,
      transaction: t,
    });
    await Refund.schema(schemaName).sync({ force: true, transaction: t });
    await RefundItem.schema(schemaName).sync({ force: true, transaction: t });
    await RefundPayment.schema(schemaName).sync({
      force: true,
      transaction: t,
    });

    // 4. Create Main Branch (Fix: Use store name instead of 'Main Branch')
    const mainBranch = await Branch.schema(schemaName).create(
      {
        name: (tenantData.name || "Main Branch").toLowerCase(), // Dynamic Name
        location: "Main Location",
        phone: tenantData.phone,
        is_main: true,
      },
      { transaction: t }
    );

    await User.schema(schemaName).create(
      {
        full_name: adminUserData.full_name,
        username: adminUserData.username.toLowerCase(),
        password: adminUserData.password,
        role: "store_owner",
        branch_id: mainBranch.id,
        is_active: true,
      },
      { transaction: t }
    );

    // Commit transaction before creating indexes (indexes don't need transaction)
    await t.commit();

    // Reset search_path after transaction commit
    await sequelize.query("SET search_path TO public");

    // 6. Create indexes for performance optimization
    // Note: Indexes are created outside transaction for better compatibility
    try {
      logger.info("Creating indexes for new tenant", {
        component: "schema.manager",
        schema: schemaName,
        slug: tenantData.slug,
      });

      const indexResult = await createIndexesForSchema(schemaName);

      logger.info("Indexes created successfully", {
        component: "schema.manager",
        schema: schemaName,
        slug: tenantData.slug,
        created: indexResult.created,
        skipped: indexResult.skipped,
        failed: indexResult.failed,
      });

      if (indexResult.failed > 0) {
        logger.warn("Some indexes failed to create", {
          component: "schema.manager",
          schema: schemaName,
          failedIndexes: indexResult.failedIndexes,
        });
      }

      // Create search indexes (trigram) for fast text search
      try {
        logger.info("Creating search indexes for new tenant", {
          component: "schema.manager",
          schema: schemaName,
          slug: tenantData.slug,
        });

        const searchIndexResult = await createSearchIndexesForSchema(
          schemaName
        );

        logger.info("Search indexes created successfully", {
          component: "schema.manager",
          schema: schemaName,
          slug: tenantData.slug,
          created: searchIndexResult.created,
          skipped: searchIndexResult.skipped,
          failed: searchIndexResult.failed,
        });

        if (searchIndexResult.failed > 0) {
          logger.warn("Some search indexes failed to create", {
            component: "schema.manager",
            schema: schemaName,
            failedIndexes: searchIndexResult.failedIndexes,
          });
        }
      } catch (searchIndexError) {
        // Log error but don't fail tenant creation if search indexes fail
        logger.error("Failed to create search indexes (non-critical)", {
          component: "schema.manager",
          schema: schemaName,
          slug: tenantData.slug,
          error: searchIndexError?.message,
        });
      }
    } catch (indexError) {
      // Log error but don't fail tenant creation if indexes fail
      logger.error("Failed to create indexes (non-critical)", {
        component: "schema.manager",
        schema: schemaName,
        slug: tenantData.slug,
        error: indexError?.message,
      });
    }

    logger.info("Schema and owner created", {
      component: "schema.manager",
      slug: tenantData.slug,
    });
    return true;
  } catch (error) {
    await t.rollback();
    logger.error("Schema creation error", {
      component: "schema.manager",
      error: error?.message,
      stack: error?.stack,
    });
    throw error;
  }
};
