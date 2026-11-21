import sequelize from "../../config/database.js";
import logger from "../../utils/logger.js";

export const getCustomOptions = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { type, fabric_type, category } = req.query;

    logger.info("Getting custom options", {
      component: "inventory",
      schema,
      tenantSlug: req.tenant.slug,
      type,
      fabric_type,
      category,
    });

    let whereConditions = [];
    const queryParams = [];
    let paramIndex = 1;

    if (type) {
      whereConditions.push(`type = $${paramIndex++}`);
      queryParams.push(type);

      if (type === "fabric") {
        whereConditions.push(`fabric_type IS NULL`);
        whereConditions.push(`category IS NULL`);
      }

      else if (type === "category") {
        whereConditions.push(`category IS NULL`);
        if (fabric_type) {
          whereConditions.push(`fabric_type = $${paramIndex++}`);
          queryParams.push(fabric_type);
        }
      }

      else if (type === "pattern") {
        if (fabric_type) {
          whereConditions.push(`fabric_type = $${paramIndex++}`);
          queryParams.push(fabric_type);
        }
        if (category) {
          whereConditions.push(`category = $${paramIndex++}`);
          queryParams.push(category);
        }
      }
    } else {

      if (fabric_type) {
        whereConditions.push(`fabric_type = $${paramIndex++}`);
        queryParams.push(fabric_type);
      }
      if (category) {
        whereConditions.push(`category = $${paramIndex++}`);
        queryParams.push(category);
      }
    }

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(" AND ")}`
        : "";

    const t = await sequelize.transaction();
    try {
      await sequelize.query(`SET LOCAL search_path TO "${schema}", public`, {
        transaction: t,
      });

      const query = `
        SELECT id, type, fabric_type, category, name, name_ar
        FROM "${schema}".custom_inventory_options
        ${whereClause}
        ORDER BY name ASC
      `;

      const results = await sequelize.query(query, {
        bind: queryParams,
        type: sequelize.QueryTypes.SELECT,
        transaction: t,
      });

      await t.commit();

      const options = Array.isArray(results) ? results : [];

      logger.info("Custom options fetched", {
        component: "inventory",
        schema,
        type,
        fabric_type,
        category,
        count: options.length,
      });

      res.json({
        success: true,
        data: options,
      });
    } catch (error) {
      await t.rollback();
      throw error;
    }
  } catch (error) {
    logger.error("Get custom options error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to fetch custom options." });
  }
};

export const saveCustomOption = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { type, fabric_type, category, name, name_ar } = req.body;

    logger.info("Saving custom option", {
      component: "inventory",
      schema,
      tenantSlug: req.tenant.slug,
      type,
      fabric_type,
      category,
      name: name?.trim(),
    });

    if (!type || !name) {
      return res.status(400).json({ message: "Type and name are required." });
    }

    if (!["fabric", "category", "pattern"].includes(type)) {
      return res.status(400).json({
        message: "Invalid type. Must be fabric, category, or pattern.",
      });
    }

    if (type === "category" && !fabric_type) {
      return res
        .status(400)
        .json({ message: "fabric_type is required for category." });
    }
    if (type === "pattern" && (!fabric_type || !category)) {
      return res.status(400).json({
        message: "fabric_type and category are required for pattern.",
      });
    }

    const trimmedName = name.trim();
    const trimmedNameAr = name_ar?.trim() || null;

    const t = await sequelize.transaction();
    try {
      await sequelize.query(`SET LOCAL search_path TO "${schema}", public`, {
        transaction: t,
      });

      const checkQuery = `
        SELECT id, type, fabric_type, category, name, name_ar
        FROM "${schema}".custom_inventory_options
        WHERE type = $1
          AND (fabric_type = $2 OR (fabric_type IS NULL AND $2 IS NULL))
          AND (category = $3 OR (category IS NULL AND $3 IS NULL))
          AND name = $4
        LIMIT 1
      `;

      const existingRows = await sequelize.query(checkQuery, {
        bind: [type, fabric_type || null, category || null, trimmedName],
        type: sequelize.QueryTypes.SELECT,
        transaction: t,
      });

      if (
        existingRows &&
        Array.isArray(existingRows) &&
        existingRows.length > 0
      ) {
        await t.commit();
        return res.json({
          success: true,
          data: existingRows[0],
          message: "Option already exists.",
        });
      }

      const insertQuery = `
        INSERT INTO "${schema}".custom_inventory_options
          (type, fabric_type, category, name, name_ar, created_by, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
        RETURNING id, type, fabric_type, category, name, name_ar, created_by, created_at, updated_at
      `;

      const insertedRows = await sequelize.query(insertQuery, {
        bind: [
          type,
          fabric_type || null,
          category || null,
          trimmedName,
          trimmedNameAr,
          req.user.id,
        ],
        type: sequelize.QueryTypes.SELECT,
        transaction: t,
      });

      if (
        !insertedRows ||
        !Array.isArray(insertedRows) ||
        insertedRows.length === 0
      ) {
        throw new Error("Failed to insert custom option - no rows returned");
      }

      await t.commit();
      const customOption = insertedRows[0];

      logger.info("Custom option saved", {
        component: "inventory",
        schema,
        type,
        fabric_type,
        category,
        name: trimmedName,
        id: customOption.id,
      });

      res.json({
        success: true,
        data: customOption,
        message: "Custom option saved successfully.",
      });
    } catch (error) {
      await t.rollback();
      throw error;
    }
  } catch (error) {
    logger.error("Save custom option error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to save custom option." });
  }
};
