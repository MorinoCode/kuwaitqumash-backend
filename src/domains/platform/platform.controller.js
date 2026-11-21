import ContactMessage from "./contact-message.model.js";
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

export const registerStore = async (_req, res) => {
  return res.status(403).json({
    success: false,
    message:
      "Public self-registration is disabled. Please contact the platform administrator to activate your store.",
  });
};
