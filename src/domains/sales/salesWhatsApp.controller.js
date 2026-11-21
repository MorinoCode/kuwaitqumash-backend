import fs from "fs";
import sequelize from "../../config/database.js";
import Invoice from "./invoice.model.js";
import InvoiceItem from "./invoice-item.model.js";
import InvoicePayment from "./payment.model.js";
import InventoryItem from "../inventory/item.model.js";
import Customer from "../customers/customer.model.js";
import User from "../auth/user.model.js";
import logger from "../../utils/logger.js";
import { generateInvoicePDF } from "../../utils/invoiceGenerator.js";
import { enqueueTransactionalDocument } from "../../queues/whatsapp.queue.js";
import { isRedisEnabled } from "../../config/redis.js";
import { Op } from "sequelize";
import Branch from "../store/branch.model.js";

export const sendInvoiceWhatsApp = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const { phone } = req.body;

    if (!id || isNaN(id)) {
      return res.status(400).json({ message: "Invalid invoice ID" });
    }

    const invoice = await Invoice.schema(schema).findByPk(id, {
      include: [{ model: Customer.schema(schema), as: "customer" }],
    });

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    if (
      req.user.role !== "store_owner" &&
      invoice.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied to this invoice" });
    }

    if (invoice.branch_id) {
      const invoiceBranch = await Branch.schema(schema).findByPk(invoice.branch_id, {
        attributes: ["id", "whatsapp_invoice_enabled"],
      });
      if (invoiceBranch && !invoiceBranch.whatsapp_invoice_enabled) {
        return res.status(403).json({
          message:
            "Sending invoices to customers via WhatsApp is disabled for this branch.",
        });
      }
    }

    const targetPhone = phone || invoice.customer?.phone;
    if (!targetPhone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    let pdfBuffer = null;
    let pdfPath = invoice.pdf_path;

    let pdfExists = false;
    if (pdfPath) {
      try {
        await fs.promises.access(pdfPath, fs.constants.R_OK);
        pdfExists = true;
      } catch {
        pdfExists = false;
      }
    }

    if (!pdfPath || !pdfExists) {

      const invoiceWithItems = await Invoice.schema(schema).findByPk(id, {
        include: [
          { model: InvoiceItem.schema(schema), as: "items" },
          { model: InvoicePayment.schema(schema), as: "payments" },
          { model: Customer.schema(schema), as: "customer" },
          {
            model: User.schema(schema),
            as: "creator",
            attributes: ["full_name"],
          },
        ],
      });

      const inventoryItemIds = (invoiceWithItems.items || [])
        .map((item) => item.inventory_item_id)
        .filter((itemId) => itemId != null);

      const inventoryItems =
        inventoryItemIds.length > 0
          ? await InventoryItem.schema(schema).findAll({
              where: { id: { [Op.in]: inventoryItemIds } },
              attributes: ["id", "barcode", "rfid_tag", "quantity"],
            })
          : [];

      const inventoryMap = new Map(
        inventoryItems.map((item) => [item.id, item]),
      );

      const itemsWithDetails = (invoiceWithItems.items || []).map((item) => {
        const inventoryItem = inventoryMap.get(item.inventory_item_id);
        const json = item.toJSON();
        return {
          ...json,
          barcode: json.barcode ?? inventoryItem?.barcode ?? null,
          quantity: json.quantity != null ? json.quantity : 1,
          inventoryItem,
        };
      });

      let user = null;
      try {
        user = await User.schema(schema).findByPk(invoiceWithItems.created_by, {
          include: [
            { model: sequelize.models.Branch.schema(schema), as: "branch" },
          ],
        });
      } catch (e) {
        void e;
        user = { full_name: "Cashier", id: invoiceWithItems.created_by };
      }

      const branch = await Branch.schema(schema).findByPk(
        invoiceWithItems.branch_id,
      );
      const branchName = branch?.name || (user.branch ? user.branch.name : "Main Branch");
      const branchLogoUrl = branch?.logo_url || null;

      const storeSettings = {
        name: req.tenant.name,
        phone: req.tenant.phone,
        branchLocation: branch?.location,
        branchPhone: branch?.phone
      };

      const pdfResult = await generateInvoicePDF(
        invoiceWithItems,
        itemsWithDetails,
        invoiceWithItems.customer,
        user,
        branchName,
        storeSettings,
        branchLogoUrl,
      );

      if (pdfResult?.localPath) {
        invoice.pdf_path = pdfResult.localPath;
        await invoice.save();
        pdfPath = pdfResult.localPath;
      }

      if (pdfResult?.buffer) {
        pdfBuffer = pdfResult.buffer;
      }
    }

    if (!pdfBuffer && pdfPath) {
      try {
        pdfBuffer = await fs.promises.readFile(pdfPath);
      } catch (readErr) {
        if (readErr?.code !== "ENOENT") {
          logger.warn("Failed to read invoice PDF for WhatsApp send", {
            component: "sales",
            invoiceId: id,
            error: readErr?.message,
          });
        }
      }
    }

    if (!pdfBuffer) {
      logger.error("PDF buffer unavailable for WhatsApp send", {
        component: "sales",
        invoiceId: id,
        pdfPath,
        branchId: invoice.branch_id,
      });
      return res.status(500).json({
        message: "PDF generation failed. Please try again.",
      });
    }

    const fileName = `invoice-${invoice.invoice_number}.pdf`;
    const caption = `Invoice ${invoice.invoice_number}`;

    if (isRedisEnabled()) {
      const jobId = await enqueueTransactionalDocument({
        tenantSlug: req.tenant.slug,
        phone: targetPhone,
        pdfBuffer,
        fileName,
        caption,
        branchId: invoice.branch_id,
        invoiceNumber: invoice.invoice_number,
      });
      return res.status(202).json({
        success: true,
        queued: true,
        jobId,
        message: "Invoice queued for WhatsApp delivery",
      });
    }

    const { sendWhatsAppDocument } = await import(
      "../../utils/whatsapp.service.js"
    );
    const success = await sendWhatsAppDocument(
      req.tenant.slug,
      targetPhone,
      pdfBuffer,
      fileName,
      caption,
      invoice.branch_id,
    );

    if (success) {
      return res.json({
        success: true,
        message: "Invoice sent via WhatsApp successfully",
      });
    }

    logger.warn("sendWhatsAppDocument returned false", {
      component: "sales",
      invoiceId: id,
      branchId: invoice.branch_id,
      tenantSlug: req.tenant.slug,
    });
    return res.status(500).json({
      message:
        "Failed to send invoice via WhatsApp. Please check WhatsApp connection.",
    });
  } catch (error) {
    logger.error("Send WhatsApp error", {
      component: "sales",
      error: error?.message,
      stack: error?.stack,
      invoiceId: req?.params?.id,
    });
    res.status(500).json({
      message: "Failed to send invoice via WhatsApp. Please try again.",
    });
  }
};

