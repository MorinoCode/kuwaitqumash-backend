import Tenant from "./tenant.model.js";
import ContactMessage from "./contact-message.model.js";
import { createTenantSchema } from "../../utils/schema.manager.js";
import logger from "../../utils/logger.js";

export const submitContactMessage = async (req, res) => {
  try {
    const { name, contact, message } = req.body;

    const saved = await ContactMessage.create({ name, contact, message });

    res.status(201).json({
      success: true,
      message: "Message received",
      data: { id: saved.id },
    });
  } catch (error) {
    logger.error("Contact message error", {
      component: "platform",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to send your message. Please try again." });
  }
};

export const listContactMessages = async (req, res) => {
  try {
    const messages = await ContactMessage.findAll({
      order: [
        ["created_at", "DESC"],
        ["id", "DESC"],
      ],
      limit: 200,
    });

    res.json({ success: true, data: messages });
  } catch (error) {
    logger.error("List contact messages error", {
      component: "platform",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to load messages." });
  }
};

export const markContactMessageRead = async (req, res) => {
  try {
    const message = await ContactMessage.findByPk(req.params.id);
    if (!message) return res.status(404).json({ message: "Message not found" });

    await message.update({ status: "read" });

    res.json({ success: true, data: message });
  } catch (error) {
    logger.error("Mark contact message read error", {
      component: "platform",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to update the message." });
  }
};

export const registerStore = async (req, res) => {
  try {
    let { store_name, owner_name, phone, username, password } = req.body;
    store_name = store_name.toLowerCase();
    username = username.toLowerCase();

    const slug = store_name
      .toLowerCase()
      .replace(/ /g, "-")
      .replace(/[^\w-]+/g, "");
    const db_schema = `tenant_${slug.replace(/-/g, "_")}`;

    if (!/^[a-zA-Z0-9_]+$/.test(db_schema)) {
      return res.status(400).json({ message: "Invalid store name format." });
    }

    const existingTenant = await Tenant.findOne({ where: { slug } });
    if (existingTenant) {
      return res.status(400).json({ message: "Store name is already taken." });
    }

    const newTenant = await Tenant.create({
      name: store_name,
      slug,
      db_schema,
      owner_name,
      phone,
      subscription_status: "active",
    });

    try {
      await createTenantSchema(newTenant, {
        full_name: owner_name,
        username,
        password,
      });
    } catch (schemaError) {
      try {
        await Tenant.destroy({ where: { id: newTenant.id } });
      } catch (destroyErr) {
        logger.error("Failed to rollback tenant after schema error", {
          component: "platform",
          tenantId: newTenant.id,
          slug,
          destroyError: destroyErr?.message,
        });
      }
      logger.error("Schema creation failed, tenant rolled back", {
        component: "platform",
        slug,
        message: schemaError?.message,
        code: schemaError?.code,
        stack: schemaError?.stack,
      });
      throw schemaError;
    }

    res.status(201).json({
      success: true,
      message: "Store registered successfully.",
      tenant_id: slug,
      schema: db_schema,
    });
  } catch (error) {
    logger.error("Registration error", {
      component: "platform",
      message: error?.message,
      code: error?.code,
      stack: error?.stack,
    });
    const isProduction = process.env.NODE_ENV === "production";
    res.status(500).json({
      message: isProduction
        ? "An error occurred during registration. Please try again later."
        : error?.message ||
          "An error occurred during registration. Please try again later.",
    });
  }
};
