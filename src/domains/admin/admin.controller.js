import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import sequelize from "../../config/database.js";
import Tenant from "../platform/tenant.model.js";
import WhatsAppConfig from "../platform/whatsapp.config.model.js";
import Branch from "../store/branch.model.js";
import User from "../auth/user.model.js";
import InventoryItem from "../inventory/item.model.js";
import Invoice from "../sales/invoice.model.js";
import Customer from "../customers/customer.model.js";
import ContactMessage from "../platform/contact-message.model.js";
import {
  provisionStore,
  StoreProvisioningError,
} from "../platform/tenantProvisioning.service.js";
import { invalidateTenantCache } from "../../utils/tenant-cache.js";
import { deleteImage, deleteStoreFolder } from "../../utils/fileUpload.js";
import logger from "../../utils/logger.js";
import {
  extractBearerToken,
  getAdminJwtSecret,
  revokeAdminToken,
} from "./admin.middleware.js";

const SCHEMA_PATTERN = /^[a-zA-Z0-9_]+$/;
const ALLOWED_STATUSES = ["active", "inactive", "suspended"];

const safeStringEqual = (a, b) => {
  const aDigest = crypto.createHash("sha256").update(String(a || "")).digest();
  const bDigest = crypto.createHash("sha256").update(String(b || "")).digest();
  return crypto.timingSafeEqual(aDigest, bDigest);
};

const verifyAdminPassword = async (candidate) => {
  if (process.env.ADMIN_PASSWORD_HASH) {
    return bcrypt.compare(candidate, process.env.ADMIN_PASSWORD_HASH);
  }
  if (process.env.ADMIN_PASSWORD) {
    return safeStringEqual(candidate, process.env.ADMIN_PASSWORD);
  }
  return false;
};

const loadTenantWithSchema = async (id, res) => {
  const tenant = await Tenant.findByPk(id);
  if (!tenant) {
    res.status(404).json({ message: "Tenant not found." });
    return null;
  }
  if (!SCHEMA_PATTERN.test(tenant.db_schema)) {
    res.status(500).json({ message: "Invalid tenant schema identifier." });
    return null;
  }
  return tenant;
};

const parseLimit = (raw, fallback = 100, max = 250) => {
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed < 1) return fallback;
  return Math.min(parsed, max);
};

export const login = async (req, res) => {
  try {
    const adminEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
    const hasPasswordConfigured = Boolean(
      process.env.ADMIN_PASSWORD_HASH || process.env.ADMIN_PASSWORD,
    );

    if (!adminEmail || !hasPasswordConfigured) {
      return res.status(503).json({
        message: "Admin login is not configured on this server.",
      });
    }

    const submittedEmail = String(req.body.email || "").trim().toLowerCase();
    const submittedPassword = String(req.body.password || "");

    const emailMatches = safeStringEqual(submittedEmail, adminEmail);
    const passwordMatches = await verifyAdminPassword(submittedPassword);

    if (!emailMatches || !passwordMatches) {
      return res.status(401).json({ message: "Invalid admin credentials." });
    }

    const secret = getAdminJwtSecret();
    if (!secret) {
      return res.status(500).json({
        message: "Admin authentication secret is not configured.",
      });
    }

    const fullName = process.env.ADMIN_NAME || "Platform Admin";
    const token = jwt.sign(
      {
        id: "platform_admin",
        email: adminEmail,
        full_name: fullName,
        role: "super_admin",
        type: "admin",
        jti: crypto.randomUUID(),
      },
      secret,
      { algorithm: "HS256", expiresIn: "12h" },
    );

    return res.json({
      success: true,
      data: {
        token,
        user: { email: adminEmail, full_name: fullName, role: "super_admin" },
      },
    });
  } catch (error) {
    logger.error("Admin login error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to authenticate admin." });
  }
};

export const getMe = async (req, res) => {
  return res.json({
    success: true,
    data: req.admin,
  });
};

export const logout = async (req, res) => {
  try {
    const token = req.adminToken || extractBearerToken(req);
    const secret = getAdminJwtSecret();
    if (token && secret) {
      let decoded = req.adminTokenDecoded;
      if (!decoded) {
        try {
          decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
        } catch {
          decoded = null;
        }
      }
      if (decoded) {
        await revokeAdminToken(decoded, token);
      }
    }
  } catch (error) {
    logger.warn("Failed to revoke admin token on logout", {
      component: "admin",
      error: error?.message,
    });
  }

  return res.json({ success: true, message: "Logged out successfully." });
};

export const listTenants = async (_req, res) => {
  try {
    const tenants = await Tenant.findAll({
      order: [
        ["created_at", "DESC"],
        ["id", "DESC"],
      ],
    });

    const tenantList = await Promise.all(
      tenants.map(async (t) => {
        const tenantJson = t.toJSON();
        try {
          const ownerUser = await User.schema(t.db_schema).findOne({
            where: { role: "store_owner" },
            attributes: ["username"],
          });
          tenantJson.owner_username = ownerUser?.username || null;
        } catch {
          tenantJson.owner_username = null;
        }
        return tenantJson;
      }),
    );

    return res.json({ success: true, data: tenantList });
  } catch (error) {
    logger.error("List tenants error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to load tenants." });
  }
};

export const getTenantById = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;
    return res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error("Get tenant error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to load tenant details." });
  }
};

export const createTenant = async (req, res) => {
  try {
    const tenant = await provisionStore(req.body);
    await invalidateTenantCache(tenant.slug);
    return res.status(201).json({
      success: true,
      message: "Store created successfully.",
      data: tenant,
    });
  } catch (error) {
    if (error instanceof StoreProvisioningError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
    logger.error("Admin create tenant error", {
      component: "admin",
      error: error?.message,
      stack: error?.stack,
    });
    return res.status(500).json({ message: "Failed to create tenant." });
  }
};

export const updateTenant = async (req, res) => {
  try {
    const tenant = await Tenant.findByPk(req.params.id);
    if (!tenant) {
      return res.status(404).json({ message: "Tenant not found." });
    }

    const { name, owner_name, phone, subscription_status, subscription_expires_at } =
      req.body;

    if (name !== undefined) tenant.name = name;
    if (owner_name !== undefined) tenant.owner_name = owner_name;
    if (phone !== undefined) tenant.phone = phone;
    if (
      subscription_status !== undefined &&
      ALLOWED_STATUSES.includes(subscription_status)
    ) {
      tenant.subscription_status = subscription_status;
    }
    if (subscription_expires_at !== undefined) {
      if (!subscription_expires_at) {
        tenant.subscription_expires_at = null;
      } else {
        const parsedDate = new Date(subscription_expires_at);
        if (Number.isNaN(parsedDate.getTime())) {
          return res
            .status(400)
            .json({ message: "Invalid subscription expiry date." });
        }
        tenant.subscription_expires_at = parsedDate;
      }
    }

    await tenant.save();
    await invalidateTenantCache(tenant.slug);

    return res.json({ success: true, data: tenant });
  } catch (error) {
    logger.error("Update tenant error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to update tenant." });
  }
};

export const deleteTenant = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const schemaName = tenant.db_schema;
    const slug = tenant.slug;

    await WhatsAppConfig.destroy({ where: { tenant_slug: slug } });
    await sequelize.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
    await tenant.destroy();
    await invalidateTenantCache(slug);
    await deleteStoreFolder(slug);

    return res.json({
      success: true,
      message: "Tenant deleted successfully.",
    });
  } catch (error) {
    logger.error("Delete tenant error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to delete tenant." });
  }
};

export const listTenantBranches = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const branches = await Branch.schema(tenant.db_schema).findAll({
      order: [
        ["is_main", "DESC"],
        ["id", "ASC"],
      ],
    });
    return res.json({ success: true, data: branches });
  } catch (error) {
    logger.error("List tenant branches error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to load branches." });
  }
};

export const createTenantBranch = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const branch = await Branch.schema(tenant.db_schema).create({
      name: req.body.name,
      location: req.body.location || null,
      phone: req.body.phone || null,
      is_main: false,
    });
    return res.status(201).json({ success: true, data: branch });
  } catch (error) {
    logger.error("Create tenant branch error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to create branch." });
  }
};

export const updateTenantBranch = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const branch = await Branch.schema(tenant.db_schema).findByPk(
      req.params.branchId,
    );
    if (!branch) {
      return res.status(404).json({ message: "Branch not found." });
    }

    await branch.update({
      name: req.body.name,
      location: req.body.location ?? branch.location,
      phone: req.body.phone ?? branch.phone,
    });

    return res.json({ success: true, data: branch });
  } catch (error) {
    logger.error("Update tenant branch error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to update branch." });
  }
};

export const deleteTenantBranch = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const schema = tenant.db_schema;
    const branch = await Branch.schema(schema).findByPk(req.params.branchId);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found." });
    }

    if (branch.is_main) {
      return res
        .status(400)
        .json({ message: "Cannot delete the main branch." });
    }

    const [userCount, invoiceCount, inventoryCount] = await Promise.all([
      User.schema(schema).count({ where: { branch_id: branch.id } }),
      Invoice.schema(schema).count({ where: { branch_id: branch.id } }),
      InventoryItem.schema(schema).count({ where: { branch_id: branch.id } }),
    ]);

    if (userCount > 0 || invoiceCount > 0 || inventoryCount > 0) {
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

    return res.json({ success: true, message: "Branch deleted successfully." });
  } catch (error) {
    logger.error("Delete tenant branch error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to delete branch." });
  }
};

export const listTenantInventory = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const limit = parseLimit(req.query.limit, 100, 250);
    const items = await InventoryItem.schema(tenant.db_schema).findAll({
      order: [["id", "DESC"]],
      limit,
    });
    return res.json({ success: true, data: items });
  } catch (error) {
    logger.error("List tenant inventory error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to load inventory." });
  }
};

export const listTenantInvoices = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const schema = tenant.db_schema;
    const limit = parseLimit(req.query.limit, 50, 250);
    const invoices = await Invoice.schema(schema).findAll({
      include: [
        {
          model: Customer.schema(schema),
          as: "customer",
          attributes: ["id", "full_name", "phone"],
        },
      ],
      order: [
        ["created_at", "DESC"],
        ["id", "DESC"],
      ],
      limit,
    });
    return res.json({ success: true, data: invoices });
  } catch (error) {
    logger.error("List tenant invoices error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to load invoices." });
  }
};

export const listTenantCustomers = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const limit = parseLimit(req.query.limit, 100, 250);
    const customers = await Customer.schema(tenant.db_schema).findAll({
      order: [["id", "DESC"]],
      limit,
    });
    return res.json({ success: true, data: customers });
  } catch (error) {
    logger.error("List tenant customers error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to load customers." });
  }
};

export const listContactMessages = async (req, res) => {
  try {
    const limit = parseLimit(req.query.limit, 100, 250);
    const messages = await ContactMessage.findAll({
      order: [
        ["created_at", "DESC"],
        ["id", "DESC"],
      ],
      limit,
    });
    return res.json({ success: true, data: messages });
  } catch (error) {
    logger.error("List contact messages error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to load contact messages." });
  }
};

export const markContactMessageRead = async (req, res) => {
  try {
    const message = await ContactMessage.findByPk(req.params.id);
    if (!message) {
      return res.status(404).json({ message: "Contact message not found." });
    }

    const nextStatus = req.body?.status === "new" ? "new" : "read";
    await message.update({ status: nextStatus });
    return res.json({ success: true, data: message });
  } catch (error) {
    logger.error("Update contact message error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to update contact message." });
  }
};

export const deleteContactMessage = async (req, res) => {
  try {
    const message = await ContactMessage.findByPk(req.params.id);
    if (!message) {
      return res.status(404).json({ message: "Contact message not found." });
    }

    await message.destroy();
    return res.json({ success: true, message: "Contact message deleted successfully." });
  } catch (error) {
    logger.error("Delete contact message error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to delete contact message." });
  }
};

export const listTenantUsers = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const schema = tenant.db_schema;
    const users = await User.schema(schema).findAll({
      attributes: [
        "id",
        "username",
        "full_name",
        "role",
        "branch_id",
        "is_active",
        "created_at",
        "updated_at",
      ],
      include: [
        {
          model: Branch.schema(schema),
          as: "branch",
          attributes: ["id", "name"],
          required: false,
        },
      ],
      order: [
        ["role", "ASC"],
        ["id", "ASC"],
      ],
    });

    return res.json({ success: true, data: users });
  } catch (error) {
    logger.error("List tenant users error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to load tenant users." });
  }
};

export const updateTenantUserPassword = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const { password } = req.body;
    if (!password || typeof password !== "string" || password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long." });
    }

    const schema = tenant.db_schema;
    const user = await User.schema(schema).findByPk(req.params.userId);
    if (!user) {
      return res.status(404).json({ message: "User not found." });
    }

    user.password = password;
    user.token_version = (user.token_version || 0) + 1;
    await user.save();

    return res.json({
      success: true,
      message: `Password for user "${user.username}" has been updated successfully.`,
      data: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
      },
    });
  } catch (error) {
    logger.error("Update tenant user password error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to update user password." });
  }
};

export const resetTenantPassword = async (req, res) => {
  try {
    const tenant = await loadTenantWithSchema(req.params.id, res);
    if (!tenant) return;

    const { password, username } = req.body;
    if (!password || typeof password !== "string" || password.length < 6) {
      return res
        .status(400)
        .json({ message: "Password must be at least 6 characters long." });
    }

    const schema = tenant.db_schema;
    let user;
    if (username) {
      user = await User.schema(schema).findOne({
        where: { username: String(username).trim().toLowerCase() },
      });
    } else {
      user = await User.schema(schema).findOne({
        where: { role: "store_owner" },
      });
      if (!user) {
        user = await User.schema(schema).findOne({
          order: [["id", "ASC"]],
        });
      }
    }

    if (!user) {
      return res.status(404).json({ message: "No user found for this store." });
    }

    user.password = password;
    user.token_version = (user.token_version || 0) + 1;
    await user.save();

    return res.json({
      success: true,
      message: `Password for store user "${user.username}" (${tenant.name}) reset successfully.`,
      data: {
        id: user.id,
        username: user.username,
        full_name: user.full_name,
        role: user.role,
      },
    });
  } catch (error) {
    logger.error("Reset tenant password error", {
      component: "admin",
      error: error?.message,
    });
    return res.status(500).json({ message: "Failed to reset store password." });
  }
};

