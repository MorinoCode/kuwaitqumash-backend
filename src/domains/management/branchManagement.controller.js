import { Op } from "sequelize";;
import Branch from "../store/branch.model.js";
import User from "../auth/user.model.js";
import Invoice from "../sales/invoice.model.js";
import InventoryItem from "../inventory/item.model.js";
import logger from "../../utils/logger.js";
import { saveBranchLogo, deleteImage } from "../../utils/fileUpload.js";;

export const createBranch = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    let { name, location, phone } = req.body;
    name = String(name || "").trim();

    const existingBranch = await Branch.schema(schema).findOne({ where: { name: { [Op.iLike]: name } } });
    if (existingBranch) {
      return res.status(400).json({ message: "Branch name already exists" });
    }

    const newBranch = await Branch.schema(schema).create({
      name,
      location,
      phone,
      is_main: false,
    });

    res.status(201).json({
      success: true,
      message: "Branch created successfully",
      data: newBranch,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const getBranches = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    let whereClause = {};

    if (req.user.role === "branch_manager" || req.user.role === "sales_man") {
      whereClause = { id: req.user.branch_id };
    }

    const branches = await Branch.schema(schema).findAll({
      where: whereClause,
      order: [
        ["is_main", "DESC"],
        ["id", "ASC"],
      ],
    });

    res.json({ success: true, data: branches });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getBranchById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }
    if (
      (req.user.role === "branch_manager" || req.user.role === "sales_man") &&
      branch.id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    res.json({ success: true, data: branch });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const updateBranch = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const {
      name,
      location,
      phone,
      whatsapp_invoice_enabled,
      whatsapp_invoice_to_store_enabled,
      whatsapp_invoice_to_store_phone,
    } = req.body;

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }
    if (
      req.user.role !== "store_owner" &&
      branch.id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    let updates = {};
    if (location !== undefined) updates.location = location;
    if (phone !== undefined) updates.phone = phone;
    if (name) {
      const trimmedName = String(name).trim();
      if (trimmedName.toLowerCase() !== branch.name.toLowerCase()) {
        const existingBranch = await Branch.schema(schema).findOne({
          where: { name: { [Op.iLike]: trimmedName } },
        });
        if (existingBranch) {
          return res.status(400).json({ message: "Branch name already exists" });
        }
      }
      updates.name = trimmedName;
    }

    if (
      (req.user.role === "store_owner" || req.user.role === "branch_manager") &&
      whatsapp_invoice_enabled !== undefined
    ) {
      updates.whatsapp_invoice_enabled = whatsapp_invoice_enabled;
    }

    if (req.user.role === "store_owner") {
      if (whatsapp_invoice_to_store_enabled !== undefined)
        updates.whatsapp_invoice_to_store_enabled =
          whatsapp_invoice_to_store_enabled;
      if (whatsapp_invoice_to_store_phone !== undefined)
        updates.whatsapp_invoice_to_store_phone =
          whatsapp_invoice_to_store_phone;
    }
    await branch.update(updates);
    res.json({
      success: true,
      message: "Branch updated successfully",
      data: branch,
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const uploadBranchLogo = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const tenantSlug = req.tenant.slug;

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    if (req.user.role !== "store_owner" && req.user.role !== "branch_manager") {
      return res.status(403).json({
        message:
          "Access denied. Only store owner and branch manager can upload logo.",
      });
    }
    if (
      req.user.role === "branch_manager" &&
      branch.id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ message: "File size exceeds 5MB limit" });
    }

    if (branch.logo_url) {
      try {
        await deleteImage(branch.logo_url);
      } catch (error) {
        logger.warn("Failed to delete old logo", {
          component: "management",
          error: error?.message,
        });
      }
    }

    const logoUrl = await saveBranchLogo(req.file, tenantSlug, id);

    await branch.update({ logo_url: logoUrl });

    await branch.reload();

    res.json({
      success: true,
      message: "Logo uploaded successfully",
      data: { logo_url: branch.logo_url },
    });
  } catch (error) {
    logger.error("Logo upload error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({
      message: error.message || "Failed to upload logo. Please try again.",
    });
  }
};

export const deleteBranchLogo = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    if (req.user.role !== "store_owner" && req.user.role !== "branch_manager") {
      return res.status(403).json({
        message:
          "Access denied. Only store owner and branch manager can delete logo.",
      });
    }
    if (
      req.user.role === "branch_manager" &&
      branch.id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (!branch.logo_url) {
      return res.status(404).json({ message: "No logo found to delete" });
    }

    try {
      await deleteImage(branch.logo_url);
    } catch (error) {
      logger.warn("Failed to delete logo from Cloudinary", {
        component: "management",
        error: error?.message,
      });
    }

    await branch.update({ logo_url: null });

    await branch.reload();

    res.json({
      success: true,
      message: "Logo deleted successfully",
    });
  } catch (error) {
    logger.error("Logo delete error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to delete logo. Please try again." });
  }
};

export const deleteBranch = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) return res.status(404).json({ message: "Branch not found" });

    if (branch.is_main) {
      return res
        .status(403)
        .json({ message: "Cannot delete the Main Branch (HQ)." });
    }

    const [staffCount, invoiceCount, inventoryCount] = await Promise.all([
      User.schema(schema).count({ where: { branch_id: id } }),
      Invoice.schema(schema).count({ where: { branch_id: id } }),
      InventoryItem.schema(schema).count({ where: { branch_id: id } }),
    ]);

    if (staffCount > 0 || invoiceCount > 0 || inventoryCount > 0) {
      return res.status(409).json({
        message:
          "Cannot delete branch with assigned staff, inventory items, or historical invoices.",
      });
    }

    const oldLogo = branch.logo_url;
    await branch.destroy();
    if (oldLogo) {
      await deleteImage(oldLogo);
    }
    res.json({ success: true, message: "Branch deleted successfully" });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

