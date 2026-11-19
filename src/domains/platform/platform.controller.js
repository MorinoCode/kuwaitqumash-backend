import ContactMessage from "./contact-message.model.js";
import {
  provisionStore,
  StoreProvisioningError,
} from "./tenantProvisioning.service.js";
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

export const registerStore = async (req, res) => {
  if (process.env.ALLOW_PUBLIC_SIGNUP === "false") {
    return res.status(403).json({
      success: false,
      message:
        "Public self-registration is disabled. Please contact the platform administrator to activate your store.",
    });
  }

  try {
    const newTenant = await provisionStore(req.body);

    res.status(201).json({
      success: true,
      message: "Store registered successfully.",
      tenant_id: newTenant.slug,
      schema: newTenant.db_schema,
    });
  } catch (error) {
    if (error instanceof StoreProvisioningError) {
      return res.status(error.statusCode).json({ message: error.message });
    }
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
