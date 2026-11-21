import InventoryItem from "./item.model.js";
import InvoiceItem from "../sales/invoice-item.model.js";
import Branch from "../store/branch.model.js";
import { Op } from "sequelize";;
import { generateUniqueBarcode } from "../../utils/barcode.js";;
import { normalizeToLatinDigits } from "../../utils/normalizeNumbers.js";;
import logger from "../../utils/logger.js";
import { invalidateDashboardCache } from "../../utils/dashboard-cache.js";;
import { shouldRearmAlert } from "../../utils/lowStock.js";;

export const addItem = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;

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
      composition,
      pattern,
      color,
      width_cm,
      unit,
      length_m,
      roll_length_m,
      quantity,
      cost_per_meter,
      price_per_meter,
      country_of_origin,
      description,
      description_ar,
      barcode,
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

    // Sell price parsing (allows 0 without converting to null)
    let parsedSellPrice = 0;
    if (
      price_per_meter !== undefined &&
      price_per_meter !== null &&
      String(price_per_meter).trim() !== ""
    ) {
      const parsed = parseFloat(
        normalizeToLatinDigits(String(price_per_meter))
      );
      if (isNaN(parsed) || parsed < 0) {
        return res
          .status(400)
          .json({ message: "Valid price per meter is required." });
      }
      parsedSellPrice = parsed;
    }

    // Role-based branch authorization
    let assignedBranchId;
    if (req.user.role === "store_owner") {
      if (branch_id) {
        assignedBranchId = parseInt(branch_id, 10);
        const branchExists = await Branch.schema(schema).findByPk(assignedBranchId);
        if (!branchExists) {
          return res.status(400).json({ message: "Specified branch not found." });
        }
      } else if (req.user.branch_id) {
        assignedBranchId = req.user.branch_id;
      } else {
        const primaryBranch = await Branch.schema(schema).findOne({
          order: [["id", "ASC"]],
        });
        if (!primaryBranch) {
          return res.status(400).json({ message: "No branch found for this store." });
        }
        assignedBranchId = primaryBranch.id;
      }
    } else {
      if (!req.user.branch_id) {
        return res.status(403).json({
          message: "User is not assigned to any branch.",
        });
      }
      if (branch_id && Number(branch_id) !== Number(req.user.branch_id)) {
        return res.status(403).json({
          message: "Access denied. Non-owner staff cannot add items for another branch.",
        });
      }
      assignedBranchId = req.user.branch_id;
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

    // Optional fields parsing
    const parsedComposition =
      composition && typeof composition === "string"
        ? composition.trim().substring(0, 150)
        : null;

    const validUnits = ["meter", "roll"];
    const parsedUnit =
      unit && typeof unit === "string" && validUnits.includes(unit.trim())
        ? unit.trim()
        : "meter";

    let parsedWidth = null;
    if (
      width_cm !== undefined &&
      width_cm !== null &&
      String(width_cm).trim() !== ""
    ) {
      const parsed = parseFloat(normalizeToLatinDigits(String(width_cm)));
      if (!isNaN(parsed) && parsed >= 0) {
        parsedWidth = parsed;
      }
    }

    let parsedRollLength = null;
    if (
      roll_length_m !== undefined &&
      roll_length_m !== null &&
      String(roll_length_m).trim() !== ""
    ) {
      const parsed = parseFloat(normalizeToLatinDigits(String(roll_length_m)));
      if (!isNaN(parsed) && parsed >= 0) {
        parsedRollLength = parsed;
      }
    }

    // Barcode: check custom barcode uniqueness or generate unique barcode
    let finalBarcode =
      barcode && String(barcode).trim().length > 0
        ? String(barcode).trim().substring(0, 100)
        : null;

    if (finalBarcode) {
      const existing = await InventoryItem.schema(schema).findOne({
        where: { barcode: finalBarcode },
      });
      if (existing) {
        return res
          .status(400)
          .json({ message: "Barcode already exists. Please use a unique barcode." });
      }
    } else {
      finalBarcode = await generateUniqueBarcode(
        InventoryItem.schema(schema),
        fabric_type,
        pattern,
        null
      );
    }

    const newItem = await InventoryItem.schema(schema).create({
      fabric_type,
      color: color ? String(color).trim().substring(0, 100) : null,
      item_name: sanitizedItemName,
      item_name_ar: sanitizedItemNameAr,
      composition: parsedComposition,
      pattern: pattern ? pattern.trim().substring(0, 100) : null,
      country_of_origin: country_of_origin
        ? country_of_origin.trim().substring(0, 100)
        : null,
      width_cm: parsedWidth,
      unit: parsedUnit,
      roll_length_m: parsedRollLength,
      description: sanitizedDescription,
      description_ar: sanitizedDescriptionAr,
      length_m: parsedLength,
      quantity:
        parseInt(normalizeToLatinDigits(String(quantity ?? "")), 10) || 1,
      min_stock_level:
        parseInt(normalizeToLatinDigits(String(min_stock_level ?? "")), 10) ||
        2,
      cost_per_meter: parsedBuyPrice,
      price_per_meter: parsedSellPrice,
      barcode: finalBarcode,
      branch_id: assignedBranchId,
      created_by: req.user.id,
      status: "In Stock",
    });

    const responseData = {
      id: newItem.id,
      barcode: newItem.barcode,
      item_name: newItem.item_name,
      item_name_ar: newItem.item_name_ar,
      pattern: newItem.pattern,
      fabric_type: newItem.fabric_type || "",
      composition: newItem.composition,
      color: newItem.color || null,
      width_cm:
        newItem.width_cm !== null && newItem.width_cm !== undefined
          ? parseFloat(newItem.width_cm)
          : null,
      unit: newItem.unit,
      length_m:
        newItem.length_m !== null && newItem.length_m !== undefined
          ? parseFloat(newItem.length_m)
          : 0,
      roll_length_m:
        newItem.roll_length_m !== null && newItem.roll_length_m !== undefined
          ? parseFloat(newItem.roll_length_m)
          : null,
      quantity: newItem.quantity,
      min_stock_level: newItem.min_stock_level,
      cost_per_meter:
        newItem.cost_per_meter !== null && newItem.cost_per_meter !== undefined
          ? parseFloat(newItem.cost_per_meter)
          : 0,
      price_per_meter:
        newItem.price_per_meter !== null && newItem.price_per_meter !== undefined
          ? parseFloat(newItem.price_per_meter)
          : 0,
      country_of_origin: newItem.country_of_origin,
      description: newItem.description,
      description_ar: newItem.description_ar,
      status: newItem.status,
      branch_id: newItem.branch_id,
      createdAt: newItem.createdAt,
      updatedAt: newItem.updatedAt,
    };

    await invalidateDashboardCache(req.tenant.slug);

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


export const updateItem = async (req, res) => {
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

    const {
      fabric_type,
      item_name,
      item_name_ar,
      composition,
      pattern,
      color,
      unit,
      width_cm,
      roll_length_m,
      country_of_origin,
      description,
      description_ar,
      length_m,
      quantity,
      cost_per_meter,
      price_per_meter,
      barcode,
      min_stock_level,
      status,
      branch_id,
    } = req.body;

    const updateData = {
      fabric_type,
      item_name,
      item_name_ar,
      composition,
      pattern,
      color,
      country_of_origin,
      description,
      description_ar,
      length_m,
      quantity,
      cost_per_meter,
      price_per_meter,
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
    if (updateData.composition)
      updateData.composition = updateData.composition.trim().substring(0, 150);

    if (unit !== undefined) {
      const validUnits = ["meter", "roll"];
      if (validUnits.includes(String(unit).trim())) {
        updateData.unit = String(unit).trim();
      }
    }

    if (width_cm !== undefined) {
      if (width_cm === null || String(width_cm).trim() === "") {
        updateData.width_cm = null;
      } else {
        const parsed = parseFloat(normalizeToLatinDigits(String(width_cm)));
        updateData.width_cm = isNaN(parsed) || parsed < 0 ? null : parsed;
      }
    }

    if (roll_length_m !== undefined) {
      if (roll_length_m === null || String(roll_length_m).trim() === "") {
        updateData.roll_length_m = null;
      } else {
        const parsed = parseFloat(normalizeToLatinDigits(String(roll_length_m)));
        updateData.roll_length_m = isNaN(parsed) || parsed < 0 ? null : parsed;
      }
    }

    if (price_per_meter !== undefined && price_per_meter !== null) {
      const parsed = parseFloat(normalizeToLatinDigits(String(price_per_meter)));
      if (!isNaN(parsed) && parsed >= 0) {
        updateData.price_per_meter = parsed;
      }
    }

    if (cost_per_meter !== undefined && cost_per_meter !== null) {
      const parsed = parseFloat(normalizeToLatinDigits(String(cost_per_meter)));
      if (!isNaN(parsed) && parsed >= 0) {
        updateData.cost_per_meter = parsed;
      }
    }

    if (barcode !== undefined) {
      const trimmedBarcode = barcode ? String(barcode).trim() : null;
      if (trimmedBarcode && trimmedBarcode !== item.barcode) {
        const existing = await InventoryItem.schema(schema).findOne({
          where: { barcode: trimmedBarcode, id: { [Op.ne]: item.id } },
        });
        if (existing) {
          return res.status(400).json({ message: "Barcode already exists. Please use a unique barcode." });
        }
      }
      updateData.barcode = trimmedBarcode;
    }

    if (branch_id !== undefined && branch_id !== null) {
      if (req.user.role !== "store_owner") {
        if (Number(branch_id) !== Number(req.user.branch_id)) {
          return res.status(403).json({ message: "Access denied. Non-owner staff cannot move items to another branch." });
        }
      } else {
        const targetBranchId = parseInt(branch_id, 10);
        const branchExists = await Branch.schema(schema).findByPk(targetBranchId);
        if (!branchExists) {
          return res.status(400).json({ message: "Specified target branch not found." });
        }
        updateData.branch_id = targetBranchId;
      }
    }

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
    await invalidateDashboardCache(req.tenant.slug);

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

    await item.destroy();
    await invalidateDashboardCache(req.tenant.slug);
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

