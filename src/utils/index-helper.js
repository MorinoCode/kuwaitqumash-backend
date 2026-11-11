import sequelize from "../config/database.js";
import logger from "./logger.js";

const getIndexDefinitions = () => [

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
    name: "idx_inventory_created_at",
    table: "inventory_items",
    columns: ["created_at"],
  },
  {
    name: "idx_inventory_status_branch",
    table: "inventory_items",
    columns: ["status", "branch_id"],
  },

  { name: "idx_customers_branch", table: "customers", columns: ["branch_id"] },
  {
    name: "idx_customers_created_at",
    table: "customers",
    columns: ["created_at"],
  },
  { name: "idx_customers_phone", table: "customers", columns: ["phone"] },
  { name: "idx_customers_type", table: "customers", columns: ["type"] },

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

  { name: "idx_refunds_invoice", table: "refunds", columns: ["invoice_id"] },
  { name: "idx_refunds_branch", table: "refunds", columns: ["branch_id"] },
  { name: "idx_refunds_created_at", table: "refunds", columns: ["created_at"] },

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

const getSearchIndexDefinitions = () => [

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

  {
    name: "idx_invoices_invoice_number_search",
    table: "invoices",
    column: "invoice_number",
    using: 'btree("invoice_number" text_pattern_ops)',
  },

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

export const createIndexesForSchema = async (
  schemaName,
  transaction = null,
) => {

  if (!/^[a-zA-Z0-9_]+$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }

  const indexDefinitions = getIndexDefinitions();
  const createdIndexes = [];
  const skippedIndexes = [];
  const failedIndexes = [];
  const skippedTables = [];

  await sequelize.query(`SET search_path TO "${schemaName}", public`);

  const queryOptions = transaction ? { transaction } : {};

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

  try {
    await sequelize.query("SET search_path TO public");
  } catch (resetError) {

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

export const createSearchIndexesForSchema = async (schemaName) => {

  if (!/^[a-zA-Z0-9_]+$/.test(schemaName)) {
    throw new Error(`Invalid schema name: ${schemaName}`);
  }

  const indexDefinitions = getSearchIndexDefinitions();
  const createdIndexes = [];
  const skippedIndexes = [];
  const failedIndexes = [];
  const skippedTables = [];

  await sequelize.query(`SET search_path TO "${schemaName}", public`);

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

    try {
      const [columnCheck] = await sequelize.query(
        `SELECT COUNT(*)::int as total, COUNT("${idx.column}")::int as non_null_count
         FROM "${schemaName}"."${idx.table}"
         LIMIT 1`,
        {
          type: sequelize.QueryTypes.SELECT,
        },
      );

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
