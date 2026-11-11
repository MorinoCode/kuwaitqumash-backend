import InventoryItem from "./item.model.js";
import InvoiceItem from "../sales/invoice-item.model.js";
import { Op } from "sequelize";
import sequelize from "../../config/database.js";
import { saveImage, deleteImage } from "../../utils/fileUpload.js";
import { generateUniqueBarcode } from "../../utils/barcode.js";
import { normalizeToLatinDigits } from "../../utils/normalizeNumbers.js";
import logger from "../../utils/logger.js";

export const addItem = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const tenantId = req.tenant.id;

    // Log tenant and branch info for debugging
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
      category,
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
      // Stones
      stones,
    } = req.body;

    // Input Validation & Sanitization
    if (
      !fabric_type ||
      typeof fabric_type !== "string" ||
      fabric_type.trim().length === 0
    ) {
      return res.status(400).json({ message: "Fabric type is required." });
    }

    // Item name is now optional - can be generated from pattern
    // if (!item_name || typeof item_name !== 'string' || item_name.trim().length < 1) {
    //   return res.status(400).json({ message: 'Item name is required.' });
    // }

    if (!category || typeof category !== "string") {
      return res.status(400).json({ message: "Category is required." });
    }

    // Pattern (design) is optional for fabric items.

    // Generate item_name from pattern if not provided
    let finalItemName = item_name;
    if (!finalItemName || finalItemName.trim().length === 0) {
      finalItemName = pattern || category || `${fabric_type} Item`;
    }

    // Sanitize inputs
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

    // Parse stones if it's a string
    let parsedStones = [];
    if (stones) {
      try {
        parsedStones = typeof stones === "string" ? JSON.parse(stones) : stones;
        if (!Array.isArray(parsedStones)) {
          parsedStones = [];
        }
      } catch (e) {
        logger.warn("Error parsing stones", {
          component: "inventory",
          error: e?.message,
        });
        parsedStones = [];
      }
    }

    const barcode = await generateUniqueBarcode(
      InventoryItem.schema(schema),
      fabric_type,
      category,
      null
    );

    const storageFolder = `${tenantId}_${category || "general"}`;
    const imagePromises = (req.files || []).map((file) =>
      saveImage(file, "inventory", storageFolder)
    );

    const uploadedImages = await Promise.all(imagePromises);

    const newItem = await InventoryItem.schema(schema).create({
      fabric_type,
      item_name: sanitizedItemName,
      item_name_ar: sanitizedItemNameAr,
      category: category.trim(),
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
      stones:
        fabric_type !== "Watch" && fabric_type !== "Diamond" ? parsedStones : [],
    });

    // Optimize response: Return only essential fields (exclude large fields like images)
    const responseData = {
      id: newItem.id,
      barcode: newItem.barcode,
      item_name: newItem.item_name,
      category: newItem.category,
      pattern: newItem.pattern,
      fabric_type: newItem.fabric_type || "",
      color: newItem.color || null,
      length_m: newItem.length_m,
      quantity: newItem.quantity,
      status: newItem.status,
      branch_id: newItem.branch_id,
      createdAt: newItem.createdAt,
      updatedAt: newItem.updatedAt,
      // Include thumbnail (first image) only
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
      category,
      country_of_origin,
      status: statusFilter,
      page = 1,
      limit = 50,
    } = req.query;

    // Default: In Stock. Optional ?status=Sold for "Sold out" tab.
    const listStatus = statusFilter === "Sold" ? "Sold" : "In Stock";
    const whereClause = { status: listStatus };

    if (req.user.role === "store_owner") {
      if (
        branch_ids &&
        branch_ids.trim() !== "" &&
        branch_ids !== "null" &&
        branch_ids !== "undefined"
      ) {
        // Multiple branch IDs (comma-separated)
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
        // Single branch ID (backward compatibility)
        whereClause.branch_id = branch_id;
      }
    } else {
      // Non-owners restricted to their branch
      whereClause.branch_id = req.user.branch_id;
    }

    if (fabric_type && fabric_type !== "All") whereClause.fabric_type = fabric_type;
    if (category && category !== "All") whereClause.category = category;
    if (country_of_origin && country_of_origin !== "All")
      whereClause.country_of_origin = country_of_origin;
    if (fabricType && fabricType !== "All") whereClause.fabric_type = fabricType;

    if (search) {
      // Optimized search: Use prefix matching first (faster with text_pattern_ops indexes)
      // Then fallback to contains matching for better results
      const searchTerm = search.trim();

      // Check if search looks like a barcode (alphanumeric, possibly with dashes)
      const isBarcodeLike = /^[A-Z0-9-]+$/i.test(searchTerm);

      if (isBarcodeLike && searchTerm.length >= 5) {
        // For barcode-like searches, prioritize prefix match (uses index efficiently)
        // Prefix match is much faster than contains match
        whereClause[Op.or] = [
          { barcode: { [Op.iLike]: `${searchTerm}%` } }, // Prefix match (uses index)
          { barcode: { [Op.iLike]: `%${searchTerm}%` } }, // Contains match (fallback)
          { item_name: { [Op.iLike]: `${searchTerm}%` } }, // Prefix match
          { item_name: { [Op.iLike]: `%${searchTerm}%` } }, // Contains match
          { item_name_ar: { [Op.iLike]: `${searchTerm}%` } },
          { item_name_ar: { [Op.iLike]: `%${searchTerm}%` } },
          { description: { [Op.iLike]: `%${searchTerm}%` } },
        ];
      } else {
        // For text searches, use prefix matching first (faster with indexes)
        // Prefix matching works better with text_pattern_ops indexes
        whereClause[Op.or] = [
          // Prefix matches first (use indexes efficiently)
          { item_name: { [Op.iLike]: `${searchTerm}%` } },
          { item_name_ar: { [Op.iLike]: `${searchTerm}%` } },
          { barcode: { [Op.iLike]: `${searchTerm}%` } },
          // Contains matches (fallback for better coverage)
          { item_name: { [Op.iLike]: `%${searchTerm}%` } },
          { item_name_ar: { [Op.iLike]: `%${searchTerm}%` } },
          { barcode: { [Op.iLike]: `%${searchTerm}%` } },
          { description: { [Op.iLike]: `%${searchTerm}%` } },
        ];
      }
    }

    // Parse pagination parameters
    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    // Optimize count query: Use estimated count for first page without search
    // For search queries or pagination, we need exact count
    let totalCount;
    const needsExactCount = search || pageNum > 1;

    if (needsExactCount) {
      // For search queries or pagination, we need exact count
      totalCount = await InventoryItem.schema(schema).count({
        where: whereClause,
      });
    } else {
      // For first page without search, use estimated count approach
      // Fetch items first to check if there are more (faster than count)
      const items = await InventoryItem.schema(schema).findAll({
        where: whereClause,
        order: [["createdAt", "DESC"]],
        limit: limitNum + 1, // Fetch one extra to check if there are more
        offset: 0,
      });

      // Transform items to include only first image (thumbnail) for list view
      const optimizedItems = items.map((item) => {
        const itemData = item.toJSON();
        // Keep only first image as thumbnail for list view
        if (
          itemData.images &&
          Array.isArray(itemData.images) &&
          itemData.images.length > 0
        ) {
          itemData.thumbnail = itemData.images[0];
        } else {
          itemData.thumbnail = null;
        }
        // Remove full images array to reduce payload
        delete itemData.images;
        return itemData;
      });

      // If we got more than limit, there are more pages
      const hasMore = optimizedItems.length > limitNum;
      const actualItems = optimizedItems.slice(0, limitNum);

      // For estimated count: if hasMore, estimate higher number
      // Otherwise use actual count
      if (hasMore) {
        // Estimate: assume at least 2 pages worth
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

    // Optimize: Fetch only necessary attributes for list view
    // Include only first image (thumbnail) to reduce payload size
    const items = await InventoryItem.schema(schema).findAll({
      where: whereClause,
      order: [["createdAt", "DESC"]],
      limit: limitNum,
      offset: offset,
    });

    // Transform items to include only first image (thumbnail) for list view
    const optimizedItems = items.map((item) => {
      const itemData = item.toJSON();
      // Keep only first image as thumbnail for list view
      if (
        itemData.images &&
        Array.isArray(itemData.images) &&
        itemData.images.length > 0
      ) {
        itemData.thumbnail = itemData.images[0];
      } else {
        itemData.thumbnail = null;
      }
      // Remove full images array to reduce payload (frontend can fetch full details if needed)
      delete itemData.images;
      return itemData;
    });

    // Note: Price filtering (price_min, price_max) should be done in frontend
    // because it requires live rates calculation which is complex in backend

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
      category,
      country_of_origin,
      description,
      description_ar,
      length_m,
      quantity,
      cost_per_meter,
      supplier_name,
      min_stock_level,
      status,
      // Stones
      stones,
    } = req.body;

    const updateData = {
      fabric_type,
      item_name,
      item_name_ar,
      category,
      country_of_origin,
      description,
      description_ar,
      length_m,
      quantity,
      cost_per_meter,
      supplier_name,
      min_stock_level,
      status,
    };

    // Parse stones if it's a string
    if (stones !== undefined) {
      try {
        const parsedStones =
          typeof stones === "string" ? JSON.parse(stones) : stones;
        updateData.stones = Array.isArray(parsedStones) ? parsedStones : [];
      } catch (e) {
        if (process.env.NODE_ENV === "development") {
          console.error("Error parsing stones:", e);
        }
        updateData.stones = [];
      }
    }

    // Sanitize string inputs
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
      const categoryForFolder = updateData.category || item.category;
      const storageFolder = `${tenantId}_${categoryForFolder}`;

      const imagePromises = req.files.map((file) =>
        saveImage(file, "inventory", storageFolder)
      );
      const newImages = await Promise.all(imagePromises);

      const currentImages = item.images || [];
      const combinedImages = [...currentImages, ...newImages].slice(0, 5);
      updateData.images = combinedImages;
    }

    // When restocking a sold-out item (quantity 0 -> > 0), set status back to In Stock
    const newQty =
      updateData.quantity !== undefined
        ? parseInt(updateData.quantity, 10)
        : item.quantity;
    if (item.status === "Sold" && newQty > 0) {
      updateData.status = "In Stock";
    }

    await item.update(updateData);

    // Reload to get updated data
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

    // Check if item is referenced in any invoice items
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

    // Check if item is referenced in any invoice items
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

    // Delete associated images
    if (item.images && Array.isArray(item.images) && item.images.length > 0) {
      for (const img of item.images) {
        try {
          await deleteImage(img);
        } catch (imgError) {
          // Log but don't fail deletion if image deletion fails
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

    // Check for foreign key constraint error
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

// Get custom inventory options (metals, categories, subcategories)
export const getCustomOptions = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { type, fabric_type, category } = req.query;

    // Log tenant info for debugging
    logger.info("Getting custom options", {
      component: "inventory",
      schema,
      tenantSlug: req.tenant.slug,
      type,
      fabric_type,
      category,
    });

    // Build WHERE clause dynamically
    let whereConditions = [];
    const queryParams = [];
    let paramIndex = 1;

    if (type) {
      whereConditions.push(`type = $${paramIndex++}`);
      queryParams.push(type);

      // For metal type, fabric_type and category should be NULL
      if (type === "metal") {
        whereConditions.push(`fabric_type IS NULL`);
        whereConditions.push(`category IS NULL`);
      }
      // For category type, category should be NULL but fabric_type should match
      else if (type === "category") {
        whereConditions.push(`category IS NULL`);
        if (fabric_type) {
          whereConditions.push(`fabric_type = $${paramIndex++}`);
          queryParams.push(fabric_type);
        }
      }
      // For pattern type, both fabric_type and category should match
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
      // If type is not specified, filter by provided parameters
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

    // CRITICAL: Use transaction with SET LOCAL to ensure tenant isolation
    // SET LOCAL only affects the current transaction, preventing connection pooling issues
    const t = await sequelize.transaction();
    try {
      await sequelize.query(`SET LOCAL search_path TO "${schema}", public`, {
        transaction: t,
      });

      // Use raw query with explicit schema to ensure tenant isolation
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

      // results is already an array (not [results, metadata])
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

// Save custom inventory option
export const saveCustomOption = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { type, fabric_type, category, name, name_ar } = req.body;

    // Log tenant info for debugging
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

    // Validate type
    if (!["metal", "category", "pattern"].includes(type)) {
      return res.status(400).json({
        message: "Invalid type. Must be metal, category, or pattern.",
      });
    }

    // Validate required fields based on type
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

    // CRITICAL: Use transaction with SET LOCAL to ensure tenant isolation
    // SET LOCAL only affects the current transaction, preventing connection pooling issues
    const t = await sequelize.transaction();
    try {
      await sequelize.query(`SET LOCAL search_path TO "${schema}", public`, {
        transaction: t,
      });

      // Check if option already exists using raw query with explicit schema
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

      // Create new custom option using raw query with explicit schema
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
