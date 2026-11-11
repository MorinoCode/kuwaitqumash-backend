import Tenant from "./tenant.model.js";
import { createTenantSchema } from "../../utils/schema.manager.js";
import logger from "../../utils/logger.js";

export const registerStore = async (req, res) => {
  try {
    let { store_name, owner_name, phone, username, password } = req.body; // validated by Zod
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
