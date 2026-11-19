import Tenant from "./tenant.model.js";
import { createTenantSchema } from "../../utils/schema.manager.js";
import logger from "../../utils/logger.js";

const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

export class StoreProvisioningError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const buildTenantIdentifiers = (storeName) => {
  const normalizedName = String(storeName || "").trim().toLowerCase();
  const slug = normalizedName
    .replace(/\s+/g, "-")
    .replace(/[^\w-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  const db_schema = `tenant_${slug.replace(/-/g, "_")}`;

  if (!slug || !/[a-z0-9]/.test(slug) || !/^[a-zA-Z0-9_]+$/.test(db_schema)) {
    throw new StoreProvisioningError(
      "Invalid store name format. Please use English letters or numbers.",
      400
    );
  }

  return { normalizedName, slug, db_schema };
};

export const provisionStore = async ({
  store_name,
  owner_name,
  phone,
  username,
  password,
  subscription_status = "active",
  subscription_expires_at,
}) => {
  const { normalizedName, slug, db_schema } = buildTenantIdentifiers(store_name);
  const normalizedUsername = String(username || "").trim().toLowerCase();

  const existingTenant = await Tenant.findOne({ where: { slug } });
  if (existingTenant) {
    throw new StoreProvisioningError("Store name is already taken.", 400);
  }

  const expiresAt =
    subscription_expires_at === undefined
      ? new Date(Date.now() + ONE_YEAR_MS)
      : subscription_expires_at
        ? new Date(subscription_expires_at)
        : null;

  const newTenant = await Tenant.create({
    name: normalizedName,
    slug,
    db_schema,
    owner_name,
    phone,
    subscription_status,
    subscription_expires_at: expiresAt,
  });

  try {
    await createTenantSchema(newTenant, {
      full_name: owner_name,
      username: normalizedUsername,
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

  return newTenant;
};

