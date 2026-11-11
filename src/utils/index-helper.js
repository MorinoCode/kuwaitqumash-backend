/**
 * Database Index Helper
 *
 * Creates indexes for tenant schemas based on model definitions.
 * Safe to run multiple times (uses IF NOT EXISTS).
 */

import sequelize from "../config/database.js";
import logger from "./logger.js";

/**
 * Index definitions matching model definitions exactly
 * These names must match the indexes defined in the models
 */
const getIndexDefinitions = () => [
  // inventory_items - matching item.model.js
  {
    name: "idx_inventory_status",
    table: "inventory_items",
    columns: ["status"],
  },
  {
    name: "idx_inventory_branch",
    table: "inventory_items",
    columns: ["branch_id"],
  },
  {
    name: "idx_inventory_fabric_type",
    table: "inventory_items",
    columns: ["fabric_type"],
  },
  {
    name: "idx_inventory_category",
    table: "inventory_items",
    columns: ["category"],
  },
  {
    name: "idx_inventory_created_at",
    table: "inventory_items",
    columns: ["created_at"],
  },
  {
    name: "idx_inventory_status_branch",
    table: "inventory_items",
    columns: ["status", "branch_id"],
  },

  // customers - matching customer.model.js
  { name: "idx_customers_branch", table: "customers", columns: ["branch_id"] },
  {
    name: "idx_customers_created_at",
    table: "customers",
    columns: ["created_at"],
  },
  { name: "idx_customers_phone", table: "customers", columns: ["phone"] },
  { name: "idx_customers_civil_id", table: "customers", columns: ["civil_id"] },

  // invoices - matching invoice.model.js
  { name: "idx_invoices_branch", table: "invoices", columns: ["branch_id"] },
  {
    name: "idx_invoices_created_at",
    table: "invoices",
    columns: ["created_at"],
  },
  {
    name: "idx_invoices_customer",
    table: "invoices",
    columns: ["customer_id"],
  },
  { name: "idx_invoices_status", table: "invoices", columns: ["status"] },



  // refunds
  { name: "idx_refunds_invoice", table: "refunds", columns: ["invoice_id"] },
  { name: "idx_refunds_branch", table: "refunds", columns: ["branch_id"] },
  { name: "idx_refunds_created_at", table: "refunds", columns: ["created_at"] },

  // custom_inventory_options - matching custom-option.model.js
  {
    name: "idx_custom_option_type_fabric",
    table: "custom_inventory_options",
    columns: ["type", "fabric_type"],
  },
  {
    name: "idx_custom_option_type_category",
    table: "custom_inventory_options",
    columns: ["type", "fabric_type", "category"],
  },
];

/**
 * Search index definitions
 * Uses B-tree with text_pattern_ops for better prefix matching performance
 * This works without pg_trgm extension and is faster for LIKE 'prefix%' queries
 */
const getSearchIndexDefinitions = () => [
  // inventory_items search indexes
  // text_pattern_ops is optimized for pattern matching (LIKE queries)
  {
    name: "idx_inventory_item_name_search",
    table: "inventory_items",
    column: "item_name",
    using: 'btree("item_name" text_pattern_ops)',
  },
  {
    name: "idx_inventory_item_name_ar_search",
    table: "inventory_items",
    column: "item_name_ar",
    using: 'btree("item_name_ar" text_pattern_ops)',
  },
  {
    name: "idx_inventory_barcode_search",
    table: "inventory_items",
    column: "barcode",
    using: 'btree("barcode" text_pattern_ops)',
  },
  {
    name: "idx_inventory_description_search",
    table: "inventory_items",
    column: "description",
    using: 'btree("description" text_pattern_ops)',
  },

  // invoices search indexes
  {
    name: "idx_invoices_invoice_number_search",
    table: "invoices",
    column: "invoice_number",
    using: 'btree("invoice_number" text_pattern_ops)',
  },

  // customers search indexes
  {
    name: "idx_customers_full_name_search",
    table: "customers",
    column: "full_name",
    using: 'btree("full_name" text_pattern_ops)',
  },
  {
    name: "idx_customers_phone_search",
    table: "customers",
    column: "phone",
    using: 'btree("phone" text_pattern_ops)',
  },
];

/**
 * Creates all indexes for a specific tenant schema
 * @param {string} schemaName - The schema name
 * @param {object} transaction - Optional Sequelize transaction
 * @returns {Promise<void>}
 */
export const createIndexesForSchema = async (
  schemaName,
  transaction = null,
) => {
  // Validate schema name for security
  if (!/^[a-zA-Z0-9_]+$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }

  const indexDefinitions = getIndexDefinitions();
  const createdIndexes = [];
  const skippedIndexes = [];
  const failedIndexes = [];
  const skippedTables = [];

  // Set search_path to the schema
  // Note: Don't use transaction for search_path as it's session-level
  await sequelize.query(`SET search_path TO "${schemaName}", public`);

  const queryOptions = transaction ? { transaction } : {};

  // Helper function to check if table exists
  const tableExists = async (tableName) => {
    try {
      const [results] = await sequelize.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )`,
        {
          bind: [schemaName, tableName],
          ...queryOptions,
        },
      );
      return results[0]?.exists || false;
    } catch (error) {
      logger.warn("Error checking table existence", {
        component: "index-helper",
        schema: schemaName,
        table: tableName,
        error: error?.message,
      });
      return false;
    }
  };

  for (const idx of indexDefinitions) {
    // Check if table exists before creating index
    const tableExistsResult = await tableExists(idx.table);

    if (!tableExistsResult) {
      skippedTables.push(idx.table);
      logger.debug("Table does not exist, skipping index", {
        component: "index-helper",
        schema: schemaName,
        table: idx.table,
        index: idx.name,
      });
      continue;
    }

    const cols = idx.columns.map((c) => `"${c}"`).join(", ");
    const qual = `"${schemaName}"."${idx.table}"`;
    const sql = `CREATE INDEX IF NOT EXISTS "${idx.name}" ON ${qual} (${cols});`;

    try {
      await sequelize.query(sql, queryOptions);
      createdIndexes.push(idx.name);
      logger.debug("Index created", {
        component: "index-helper",
        schema: schemaName,
        index: idx.name,
      });
    } catch (e) {
      if (
        e?.message?.includes("already exists") ||
        e?.message?.includes("duplicate")
      ) {
        skippedIndexes.push(idx.name);
        logger.debug("Index already exists", {
          component: "index-helper",
          schema: schemaName,
          index: idx.name,
        });
      } else {
        failedIndexes.push({ name: idx.name, error: e?.message });
        logger.error("Index creation failed", {
          component: "index-helper",
          schema: schemaName,
          index: idx.name,
          error: e?.message,
        });
      }
    }
  }

  // Reset search_path to public
  // Note: Always reset, as search_path is session-level, not transaction-level
  try {
    await sequelize.query("SET search_path TO public");
  } catch (resetError) {
    // Ignore reset errors as they're not critical
    logger.debug("Error resetting search_path (non-critical)", {
      component: "index-helper",
      error: resetError?.message,
    });
  }

  logger.info("Indexes creation completed", {
    component: "index-helper",
    schema: schemaName,
    created: createdIndexes.length,
    skipped: skippedIndexes.length,
    failed: failedIndexes.length,
    skippedTables: skippedTables.length > 0 ? [...new Set(skippedTables)] : [],
  });

  if (failedIndexes.length > 0) {
    logger.warn("Some indexes failed to create", {
      component: "index-helper",
      schema: schemaName,
      failed: failedIndexes,
    });
  }

  if (skippedTables.length > 0) {
    logger.info("Some tables do not exist, indexes skipped", {
      component: "index-helper",
      schema: schemaName,
      skippedTables: [...new Set(skippedTables)],
    });
  }

  return {
    created: createdIndexes.length,
    skipped: skippedIndexes.length,
    failed: failedIndexes.length,
    skippedTables: skippedTables.length,
    failedIndexes,
  };
};

/**
 * Creates search indexes (trigram) for a specific tenant schema
 * @param {string} schemaName - The schema name
 * @returns {Promise<object>}
 */
export const createSearchIndexesForSchema = async (schemaName) => {
  // Validate schema name for security
  if (!/^[a-zA-Z0-9_]+$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }

  const indexDefinitions = getSearchIndexDefinitions();
  const createdIndexes = [];
  const skippedIndexes = [];
  const failedIndexes = [];
  const skippedTables = [];

  // Set search_path to the schema for index creation
  await sequelize.query(`SET search_path TO "${schemaName}", public`);

  // Helper function to check if table exists
  const tableExists = async (tableName) => {
    try {
      const [results] = await sequelize.query(
        `SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = $1 
          AND table_name = $2
        )`,
        {
          bind: [schemaName, tableName],
        },
      );
      return results[0]?.exists || false;
    } catch (error) {
      logger.warn("Error checking table existence", {
        component: "index-helper",
        schema: schemaName,
        table: tableName,
        error: error?.message,
      });
      return false;
    }
  };

  for (const idx of indexDefinitions) {
    // Check if table exists before creating index
    const tableExistsResult = await tableExists(idx.table);

    if (!tableExistsResult) {
      skippedTables.push(idx.table);
      logger.debug("Table does not exist, skipping search index", {
        component: "index-helper",
        schema: schemaName,
        table: idx.table,
        index: idx.name,
      });
      continue;
    }

    // Check if column exists and has data (not all NULL)
    // Trigram indexes don't work well on columns that are all NULL
    try {
      const [columnCheck] = await sequelize.query(
        `SELECT COUNT(*)::int as total, COUNT("${idx.column}")::int as non_null_count
         FROM "${schemaName}"."${idx.table}"
         LIMIT 1`,
        {
          type: sequelize.QueryTypes.SELECT,
        },
      );

      // Skip if column is all NULL (can't create useful index)
      if (
        columnCheck &&
        parseInt(columnCheck.non_null_count || 0) === 0 &&
        parseInt(columnCheck.total || 0) > 0
      ) {
        skippedTables.push(`${idx.table}.${idx.column}`);
        logger.debug("Column is all NULL, skipping search index", {
          component: "index-helper",
          schema: schemaName,
          table: idx.table,
          column: idx.column,
          index: idx.name,
        });
        continue;
      }
    } catch (checkError) {
      // If check fails, try to create index anyway
      logger.debug(
        "Could not check column values, proceeding with index creation",
        {
          component: "index-helper",
          schema: schemaName,
          table: idx.table,
          column: idx.column,
          error: checkError?.message,
        },
      );
    }

    const qual = `"${schemaName}"."${idx.table}"`;
    // Using clause is already properly formatted with quoted column names
    const sql = `CREATE INDEX IF NOT EXISTS "${idx.name}" ON ${qual} USING ${idx.using};`;

    try {
      await sequelize.query(sql);
      createdIndexes.push(idx.name);
      logger.debug("Search index created", {
        component: "index-helper",
        schema: schemaName,
        index: idx.name,
      });
    } catch (e) {
      // Check for specific error types
      const errorMsg = e?.message || String(e);

      if (
        errorMsg.includes("already exists") ||
        errorMsg.includes("duplicate")
      ) {
        skippedIndexes.push(idx.name);
        logger.debug("Search index already exists", {
          component: "index-helper",
          schema: schemaName,
          index: idx.name,
        });
      } else if (
        errorMsg.includes("data type") ||
        errorMsg.includes("operator class") ||
        errorMsg.includes("does not exist")
      ) {
        // Column type might not support trigram indexes or extension not available
        failedIndexes.push({
          name: idx.name,
          error: `Column/extension issue: ${errorMsg}`,
        });
        logger.warn("Search index creation failed - column/extension issue", {
          component: "index-helper",
          schema: schemaName,
          index: idx.name,
          error: errorMsg,
        });
      } else {
        failedIndexes.push({ name: idx.name, error: errorMsg });
        logger.error("Search index creation failed", {
          component: "index-helper",
          schema: schemaName,
          index: idx.name,
          error: errorMsg,
          fullError: e,
        });
      }
    }
  }

  // Reset search_path to public
  try {
    await sequelize.query("SET search_path TO public");
  } catch (resetError) {
    logger.debug("Error resetting search_path (non-critical)", {
      component: "index-helper",
      error: resetError?.message,
    });
  }

  logger.info("Search indexes creation completed", {
    component: "index-helper",
    schema: schemaName,
    created: createdIndexes.length,
    skipped: skippedIndexes.length,
    failed: failedIndexes.length,
    skippedTables: skippedTables.length > 0 ? [...new Set(skippedTables)] : [],
  });

  return {
    created: createdIndexes.length,
    skipped: skippedIndexes.length,
    failed: failedIndexes.length,
    skippedTables: skippedTables.length,
    failedIndexes,
  };
};
