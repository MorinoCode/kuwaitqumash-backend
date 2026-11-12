import InventoryItem from "./item.model.js";
import InvoiceItem from "../sales/invoice-item.model.js";
import { Op } from "sequelize";
import sequelize from "../../config/database.js";
import { saveImage, deleteImage } from "../../utils/fileUpload.js";
import { generateUniqueBarcode } from "../../utils/barcode.js";
import { normalizeToLatinDigits } from "../../utils/normalizeNumbers.js";
import logger from "../../utils/logger.js";
import { invalidateDashboardCache } from "../../utils/dashboard-cache.js";
import { shouldRearmAlert } from "../../utils/lowStock.js";

export const addItem = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const tenantId = req.tenant.id;

    logger.info("Adding inventory item", {
      component: "inventory",
      schema,
      tenantSlug: req.tenant.slug,
      branch_id: req.body.branch_id,
      user_branch_id: req.user.branch_id,
      user_role: req.user.role,
    });

    const {
      fabric_type,
      item_name,
      item_name_ar,
      pattern,
      country_of_origin,
      description,
      description_ar,
      length_m,
      quantity,
      cost_per_meter,
      price_per_meter,
      branch_id,
      min_stock_level,
    } = req.body;

    if (
      !fabric_type ||
      typeof fabric_type !== "string" ||
      fabric_type.trim().length === 0
    ) {
      return res.status(400).json({ message: "Fabric type is required." });
    }

    const parsedLength = parseFloat(
      normalizeToLatinDigits(String(length_m ?? ""))
    );
    if (isNaN(parsedLength) || !parsedLength || parsedLength <= 0) {
      return res
        .status(400)
        .json({ message: "Valid length_m (greater than 0) is required." });
    }

    const parsedBuyPrice = parseFloat(
      normalizeToLatinDigits(String(cost_per_meter ?? ""))
    );
    if (isNaN(parsedBuyPrice) || parsedBuyPrice < 0) {
      return res
        .status(400)
        .json({ message: "Valid cost per meter is required." });
    }

    let finalItemName = item_name;
    if (!finalItemName || finalItemName.trim().length === 0) {
      finalItemName = pattern || `${fabric_type} Item`;
    }

    const sanitizedItemName = finalItemName.trim().substring(0, 255);
    const sanitizedItemNameAr = item_name_ar
      ? item_name_ar.trim().substring(0, 255)
      : null;
    const sanitizedDescription = description
      ? description.trim().substring(0, 5000)
      : null;
    const sanitizedDescriptionAr = description_ar
      ? description_ar.trim().substring(0, 5000)
      : null;

    const barcode = await generateUniqueBarcode(
      InventoryItem.schema(schema),
      fabric_type,
      pattern,
      null
    );

    const storageFolder = `${tenantId}_${fabric_type || "general"}`;
    const imagePromises = (req.files || []).map((file) =>
      saveImage(file, "inventory", storageFolder)
    );

    const uploadedImages = await Promise.all(imagePromises);

    const newItem = await InventoryItem.schema(schema).create({
      fabric_type,
      color: req.body.color ? String(req.body.color).trim() : null,
      item_name: sanitizedItemName,
      item_name_ar: sanitizedItemNameAr,
      pattern: pattern ? pattern.trim() : null,
      country_of_origin: country_of_origin ? country_of_origin.trim() : null,
      description: sanitizedDescription,
      description_ar: sanitizedDescriptionAr,
      length_m: parsedLength,
      quantity:
        parseInt(normalizeToLatinDigits(String(quantity ?? "")), 10) || 1,
      min_stock_level:
        parseInt(normalizeToLatinDigits(String(min_stock_level ?? "")), 10) ||
        2,
      cost_per_meter: parsedBuyPrice,
      price_per_meter:
        price_per_meter
          ? (() => {
              const parsed = parseFloat(
                normalizeToLatinDigits(String(price_per_meter))
              );
              return isNaN(parsed) || parsed < 0 ? null : parsed;
            })()
          : null,
      barcode,
      branch_id: branch_id ? parseInt(branch_id, 10) : req.user.branch_id,
      created_by: req.user.id,
      images: uploadedImages,
      status: "In Stock",
    });

    const responseData = {
      id: newItem.id,
      barcode: newItem.barcode,
      item_name: newItem.item_name,
      pattern: newItem.pattern,
      fabric_type: newItem.fabric_type || "",
      color: newItem.color || null,
      length_m: newItem.length_m,
      quantity: newItem.quantity,
      status: newItem.status,
      branch_id: newItem.branch_id,
      createdAt: newItem.createdAt,
      updatedAt: newItem.updatedAt,

      thumbnail:
        newItem.images && newItem.images.length > 0 ? newItem.images[0] : null,
    };

    res.status(201).json({
      success: true,
      message: "Item added successfully",
      data: responseData,
    });
  } catch (error) {
    logger.error("Add Item Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to add item. Please try again." });
  }
};

export const getInventory = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const {
      branch_id,
      branch_ids,
      search,
      fabric_type,
      pattern,
      color,
      unit,
      country_of_origin,
      status: statusFilter,
      page = 1,
      limit = 50,
    } = req.query;

    const listStatus = statusFilter === "Sold" ? "Sold" : "In Stock";
    const whereClause = { status: listStatus };

    if (req.user.role === "store_owner") {
      if (
        branch_ids &&
        branch_ids.trim() !== "" &&
        branch_ids !== "null" &&
        branch_ids !== "undefined"
      ) {

        const branchIdArray = branch_ids
          .split(",")
          .map((id) => parseInt(id.trim()))
          .filter((id) => !isNaN(id) && id > 0);
        if (branchIdArray.length > 0) {
          whereClause.branch_id = { [Op.in]: branchIdArray };
        }
      } else if (
        branch_id &&
        branch_id !== "null" &&
        branch_id !== "undefined"
      ) {

        whereClause.branch_id = branch_id;
      }
    } else {

      whereClause.branch_id = req.user.branch_id;
    }

    if (fabric_type && fabric_type !== "All") whereClause.fabric_type = fabric_type;
    if (pattern && pattern !== "All") whereClause.pattern = pattern;
    if (color && color !== "All") whereClause.color = color;
    if (unit && unit !== "All") whereClause.unit = unit;
    if (country_of_origin && country_of_origin !== "All")
      whereClause.country_of_origin = country_of_origin;

    if (search) {

      const searchTerm = search.trim();

      const isBarcodeLike = /^[A-Z0-9-]+$/i.test(searchTerm);

      if (isBarcodeLike && searchTerm.length >= 5) {

        whereClause[Op.or] = [
          { barcode: { [Op.iLike]: `${searchTerm}%` } },
          { barcode: { [Op.iLike]: `%${searchTerm}%` } },
          { item_name: { [Op.iLike]: `${searchTerm}%` } },
          { item_name: { [Op.iLike]: `%${searchTerm}%` } },
          { item_name_ar: { [Op.iLike]: `${searchTerm}%` } },
          { item_name_ar: { [Op.iLike]: `%${searchTerm}%` } },
          { description: { [Op.iLike]: `%${searchTerm}%` } },
        ];
      } else {

        whereClause[Op.or] = [

          { item_name: { [Op.iLike]: `${searchTerm}%` } },
          { item_name_ar: { [Op.iLike]: `${searchTerm}%` } },
          { barcode: { [Op.iLike]: `${searchTerm}%` } },

          { item_name: { [Op.iLike]: `%${searchTerm}%` } },
          { item_name_ar: { [Op.iLike]: `%${searchTerm}%` } },
          { barcode: { [Op.iLike]: `%${searchTerm}%` } },
          { description: { [Op.iLike]: `%${searchTerm}%` } },
        ];
      }
    }

    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    let totalCount;
    const needsExactCount = search || pageNum > 1;

    if (needsExactCount) {

      totalCount = await InventoryItem.schema(schema).count({
        where: whereClause,
      });
    } else {

      const items = await InventoryItem.schema(schema).findAll({
        where: whereClause,
        order: [["createdAt", "DESC"]],
        limit: limitNum + 1,
        offset: 0,
      });

      const optimizedItems = items.map((item) => {
        const itemData = item.toJSON();

        if (
          itemData.images &&
          Array.isArray(itemData.images) &&
          itemData.images.length > 0
        ) {
          itemData.thumbnail = itemData.images[0];
        } else {
          itemData.thumbnail = null;
        }

        delete itemData.images;
        return itemData;
      });

      const hasMore = optimizedItems.length > limitNum;
      const actualItems = optimizedItems.slice(0, limitNum);

      if (hasMore) {

        totalCount = limitNum * 2;
      } else {
        totalCount = actualItems.length;
      }

      const totalPages = hasMore ? 2 : 1;

      return res.json({
        success: true,
        count: actualItems.length,
        data: actualItems,
        pagination: {
          currentPage: pageNum,
          totalPages: totalPages,
          totalItems: totalCount,
          itemsPerPage: limitNum,
          hasNextPage: hasMore,
          hasPrevPage: false,
        },
      });
    }

    const items = await InventoryItem.schema(schema).findAll({
      where: whereClause,
      order: [["createdAt", "DESC"]],
      limit: limitNum,
      offset: offset,
    });

    const optimizedItems = items.map((item) => {
      const itemData = item.toJSON();

      if (
        itemData.images &&
        Array.isArray(itemData.images) &&
        itemData.images.length > 0
      ) {
        itemData.thumbnail = itemData.images[0];
      } else {
        itemData.thumbnail = null;
      }

      delete itemData.images;
      return itemData;
    });

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      count: optimizedItems.length,
      data: optimizedItems,
      pagination: {
        currentPage: pageNum,
        totalPages: totalPages,
        totalItems: totalCount,
        itemsPerPage: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    logger.error("Get Inventory Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to fetch inventory. Please try again." });
  }
};

export const getItemById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const item = await InventoryItem.schema(schema).findByPk(id);

    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied to this item." });
    }

    res.json({ success: true, data: item });
  } catch (error) {
    logger.error("Update Item Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to update item. Please try again." });
  }
};

export const getItemByBarcode = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { barcode } = req.params;
    const item = await InventoryItem.schema(schema).findOne({
      where: { barcode },
    });

    if (!item) return res.status(404).json({ message: "Item not found" });

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied to this item." });
    }

    res.json({ success: true, data: item });
  } catch (error) {
    logger.error("Update Item Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to update item. Please try again." });
  }
};

export const updateItem = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const tenantId = req.tenant.id;
    const { id } = req.params;

    const item = await InventoryItem.schema(schema).findByPk(id);

    if (!item) return res.status(404).json({ message: "Item not found" });

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const {
      fabric_type,
      item_name,
      item_name_ar,
      composition,
      pattern,
      color,
      unit,
      country_of_origin,
      description,
      description_ar,
      length_m,
      quantity,
      cost_per_meter,
      price_per_meter,
      supplier_name,
      barcode,
      min_stock_level,
      status,
    } = req.body;

    const updateData = {
      fabric_type,
      item_name,
      item_name_ar,
      composition,
      pattern,
      color,
      unit,
      country_of_origin,
      description,
      description_ar,
      length_m,
      quantity,
      cost_per_meter,
      price_per_meter,
      supplier_name,
      barcode,
      min_stock_level,
      status,
    };

    if (updateData.item_name)
      updateData.item_name = updateData.item_name.trim().substring(0, 255);
    if (updateData.item_name_ar)
      updateData.item_name_ar = updateData.item_name_ar
        .trim()
        .substring(0, 255);
    if (updateData.description)
      updateData.description = updateData.description.trim().substring(0, 5000);
    if (updateData.description_ar)
      updateData.description_ar = updateData.description_ar
        .trim()
        .substring(0, 5000);

    if (req.files && req.files.length > 0) {
      const categoryForFolder =
        updateData.fabric_type || item.fabric_type || "general";
      const storageFolder = `${tenantId}_${categoryForFolder}`;

      const imagePromises = req.files.map((file) =>
        saveImage(file, "inventory", storageFolder)
      );
      const newImages = await Promise.all(imagePromises);

      const currentImages = item.images || [];
      const combinedImages = [...currentImages, ...newImages].slice(0, 5);
      updateData.images = combinedImages;
    }

    const newQty =
      updateData.quantity !== undefined
        ? parseInt(updateData.quantity, 10)
        : item.quantity;
    if (item.status === "Sold" && newQty > 0) {
      updateData.status = "In Stock";
    }

    // Re-arm the low-stock alert once the item is back above its limit, so a
    // dismissed alert does not hide a future shortage of the same item.
    const newMinLevel =
      updateData.min_stock_level !== undefined &&
      updateData.min_stock_level !== null
        ? Number(updateData.min_stock_level)
        : Number(item.min_stock_level);
    const newLength =
      updateData.length_m !== undefined && updateData.length_m !== null
        ? Number(updateData.length_m)
        : Number(item.length_m);
    if (
      shouldRearmAlert({
        length_m: newLength,
        quantity: newQty,
        min_stock_level: newMinLevel,
        alert_dismissed_at: item.alert_dismissed_at,
      })
    ) {
      updateData.alert_dismissed_at = null;
    }

    await item.update(updateData);

    await item.reload();

    res.json({
      success: true,
      message: "Item updated successfully",
      data: item,
    });
  } catch (error) {
    logger.error("Update Item Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to update item. Please try again." });
  }
};

export const dismissItemAlert = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const item = await InventoryItem.schema(schema).findByPk(id);
    if (!item) return res.status(404).json({ message: "Item not found" });

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    await item.update({ alert_dismissed_at: new Date() });

    await invalidateDashboardCache(req.tenant.slug);

    res.json({
      success: true,
      message: "Alert dismissed",
      data: { id: item.id, alert_dismissed_at: item.alert_dismissed_at },
    });
  } catch (error) {
    logger.error("Dismiss Item Alert Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to dismiss alert. Please try again." });
  }
};

export const deleteItemImage = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const { imageUrl } = req.body;

    const item = await InventoryItem.schema(schema).findByPk(id);
    if (!item) return res.status(404).json({ message: "Item not found" });

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const currentImages = item.images || [];
    const updatedImages = currentImages.filter((img) => img !== imageUrl);

    await deleteImage(imageUrl);

    item.images = updatedImages;
    await item.save();

    res.json({ success: true, message: "Image deleted", data: item });
  } catch (error) {
    logger.error("Delete Item Image Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to delete image. Please try again." });
  }
};

export const checkItemDeletable = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const item = await InventoryItem.schema(schema).findByPk(id);
    if (!item) {
      return res
        .status(404)
        .json({ message: "Item not found", deletable: false });
    }

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res
        .status(403)
        .json({ message: "Access denied.", deletable: false });
    }

    const invoiceItemCount = await InvoiceItem.schema(schema).count({
      where: { inventory_item_id: id },
    });

    res.json({
      deletable: invoiceItemCount === 0,
      invoiceCount: invoiceItemCount,
      message:
        invoiceItemCount > 0
          ? `This item is referenced in ${invoiceItemCount} invoice(s) and cannot be deleted.`
          : "This item can be deleted.",
    });
  } catch (error) {
    logger.error("Check Item Deletable Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({
      message: "Failed to check if item can be deleted.",
      deletable: false,
    });
  }
};

export const deleteItem = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const item = await InventoryItem.schema(schema).findByPk(id);

    if (!item) return res.status(404).json({ message: "Item not found" });

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const invoiceItemCount = await InvoiceItem.schema(schema).count({
      where: { inventory_item_id: id },
    });

    if (invoiceItemCount > 0) {
      return res.status(400).json({
        message: `Cannot delete this item. It has been sold and is referenced in ${invoiceItemCount} invoice(s). For data integrity, items that have been sold cannot be deleted.`,
        code: "ITEM_IN_USE",
        invoiceCount: invoiceItemCount,
      });
    }

    if (item.images && Array.isArray(item.images) && item.images.length > 0) {
      for (const img of item.images) {
        try {
          await deleteImage(img);
        } catch (imgError) {

          logger.warn("Failed to delete image during item deletion", {
            component: "inventory",
            imageUrl: img,
            error: imgError?.message,
          });
        }
      }
    }

    await item.destroy();
    res.json({ message: "Item deleted successfully" });
  } catch (error) {
    logger.error("Delete Item Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });

    if (
      error.name === "SequelizeForeignKeyConstraintError" ||
      error.message?.includes("foreign key constraint")
    ) {
      return res.status(400).json({
        message:
          "Cannot delete item. This item is referenced in one or more invoices and cannot be deleted.",
      });
    }

    res
      .status(500)
      .json({ message: "Failed to delete item. Please try again." });
  }
};

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
