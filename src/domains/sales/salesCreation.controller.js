import fs from "fs";
import crypto from "crypto";
import sequelize from "../../config/database.js";
import Invoice from "./invoice.model.js";
import InvoiceItem from "./invoice-item.model.js";
import InvoicePayment from "./payment.model.js";
import InventoryItem from "../inventory/item.model.js";
import Customer from "../customers/customer.model.js";
import User from "../auth/user.model.js";
import logger from "../../utils/logger.js";
import { applySaleToStock } from "../../utils/stock.js";
import { generateInvoicePDF } from "../../utils/invoiceGenerator.js";
import { enqueueTransactionalDocument } from "../../queues/whatsapp.queue.js";
import { isRedisEnabled } from "../../config/redis.js";
import { Op } from "sequelize";
import Branch from "../store/branch.model.js";
import { invalidateDashboardCache } from "../../utils/dashboard-cache.js";

export const createSale = async (req, res) => {

  const schema = req.tenant.db_schema;
  let user = null;
  try {
    user = await User.schema(schema).findByPk(req.user.id, {
      include: [
        { model: sequelize.models.Branch.schema(schema), as: "branch" },
      ],
    });
  } catch (e) {
    void e;
    user = { full_name: "Cashier", id: req.user.id };
  }

  const branchName = user.branch ? user.branch.name : "Main Branch";
  let t = null;

  try {
    t = await sequelize.transaction();
    await sequelize.query(`SET LOCAL search_path TO "${schema}", public`, {
      transaction: t,
    });
    const { customer_id, items, payments, notes, branch_id } = req.body;

    let invoiceBranchId;
    if (req.user.role === "store_owner") {
      invoiceBranchId = branch_id || req.user.branch_id;
      if (!invoiceBranchId) {
        const mainBranch = await Branch.schema(schema).findOne({
          where: { is_main: true },
          transaction: t,
        });
        invoiceBranchId = mainBranch?.id || null;
      }
      if (!invoiceBranchId) {
        throw new Error("Branch ID is required for invoice creation.");
      }
    } else {
      if (!req.user.branch_id) {
        await t.rollback();
        return res.status(403).json({
          message: "User is not assigned to any branch.",
        });
      }
      if (branch_id && Number(branch_id) !== Number(req.user.branch_id)) {
        await t.rollback();
        return res.status(403).json({
          message: "Access denied. Non-owner staff cannot create sales for another branch.",
        });
      }
      invoiceBranchId = req.user.branch_id;
    }

    logger.info("Creating invoice", {
      component: "sales",
      customer_id,
      items_count: items?.length || 0,
      payments_count: payments?.length || 0,
      notes,
      invoice_branch_id: invoiceBranchId,
      user_branch_id: req.user.branch_id,
    });

    if (!customer_id) throw new Error("Customer ID is required.");
    if (!items || items.length === 0) throw new Error("No items in cart.");
    if (!payments || payments.length === 0)
      throw new Error("At least one payment method is required.");

    const customer = await Customer.schema(schema).findByPk(customer_id, {
      transaction: t,
    });
    if (!customer) throw new Error("Customer not found.");

    let totalMeters = 0;
    let totalDiscount = 0;
    let grandTotal = 0;
    const invoiceItemsData = [];

    // Pre-lock all cart inventory items in a single deterministic ascending-ID query
    // to eliminate N+1 lock roundtrips and prevent concurrent checkout deadlocks.
    const uniqueCartItemIds = [
      ...new Set(
        items
          .map((item) => Number(item.id))
          .filter((itemId) => Number.isInteger(itemId) && itemId > 0),
      ),
    ].sort((a, b) => a - b);

    const lockedInventoryRows =
      uniqueCartItemIds.length > 0
        ? await InventoryItem.schema(schema).findAll({
            where: { id: { [Op.in]: uniqueCartItemIds } },
            order: [["id", "ASC"]],
            transaction: t,
            lock: t.LOCK.UPDATE,
          })
        : [];
    const lockedInventoryMap = new Map(
      lockedInventoryRows.map((row) => [Number(row.id), row]),
    );

    for (const item of items) {
      const inventoryItem = lockedInventoryMap.get(Number(item.id));
      if (!inventoryItem) throw new Error(`Item with ID ${item.id} not found.`);

      if (
        req.user.role !== "store_owner" &&
        Number(inventoryItem.branch_id) !== Number(req.user.branch_id)
      ) {
        throw new Error(`Item belongs to another branch.`);
      }
      if (
        req.user.role === "store_owner" &&
        Number(inventoryItem.branch_id) !== Number(invoiceBranchId)
      ) {
        throw new Error(`Item belongs to a different branch than the selected invoice branch.`);
      }
      if (inventoryItem.status !== "In Stock" || inventoryItem.quantity <= 0) {
        throw new Error(`Item is out of stock.`);
      }

      const quantity = Math.max(1, parseInt(item.quantity, 10) || 1);

      const meters = parseFloat(item.meters || inventoryItem.length_m);
      if (isNaN(meters) || meters <= 0) {
        throw new Error(
          "Invalid length (meters) for item " + (item.id || inventoryItem.id),
        );
      }

      const stock = applySaleToStock(inventoryItem, meters, quantity);
      if (!stock.ok) {
        throw new Error(
          stock.reason === "insufficient"
            ? `Not enough stock for item ${inventoryItem.item_name || item.id}. Available: ${stock.availableMeters.toFixed(3)} m, requested: ${stock.soldMeters.toFixed(3)} m.`
            : `Invalid length (meters) for item ${item.id || inventoryItem.id}`,
        );
      }

      const catalogPrice = parseFloat(inventoryItem.price_per_meter || 0);
      const pricePerMeter = parseFloat(item.price_per_meter);
      if (isNaN(pricePerMeter) || pricePerMeter <= 0) {
        throw new Error(
          "Invalid price per meter for item " + (item.id || inventoryItem.id),
        );
      }

      if (
        req.user.role === "sales_man" &&
        catalogPrice > 0 &&
        pricePerMeter < catalogPrice - 0.001
      ) {
        throw new Error(
          `Sales staff cannot sell "${inventoryItem.item_name}" below catalog price (${catalogPrice.toFixed(3)} KWD/m).`,
        );
      }

      const lineDiscount = parseFloat(item.discount || 0);
      if (isNaN(lineDiscount) || lineDiscount < 0) {
        throw new Error(
          "Invalid discount for item " + (item.id || inventoryItem.id),
        );
      }

      const grossLine =
        Math.round(meters * pricePerMeter * quantity * 1000) / 1000;
      if (lineDiscount > grossLine) {
        throw new Error(
          "Discount exceeds line total for item " +
            (item.id || inventoryItem.id),
        );
      }

      const maxSalesmanDiscountPct = Number(
        process.env.MAX_SALESMAN_DISCOUNT_PCT ?? 25,
      );
      if (
        req.user.role === "sales_man" &&
        grossLine > 0 &&
        Number.isFinite(maxSalesmanDiscountPct) &&
        maxSalesmanDiscountPct >= 0 &&
        (lineDiscount / grossLine) * 100 > maxSalesmanDiscountPct + 0.01
      ) {
        throw new Error(
          `Discount for "${inventoryItem.item_name}" exceeds the ${maxSalesmanDiscountPct}% limit for sales staff.`,
        );
      }

      const itemTotal = Math.round((grossLine - lineDiscount) * 1000) / 1000;
      if (!itemTotal || itemTotal <= 0) {
        throw new Error(
          "Total price is required for item " + (item.id || inventoryItem.id),
        );
      }

      const clientTotal = parseFloat(item.total_price);
      if (!isNaN(clientTotal) && Math.abs(clientTotal - itemTotal) > 0.01) {
        logger.warn("Line total mismatch, using server total", {
          component: "sales",
          item_id: item.id,
          client_total: clientTotal,
          server_total: itemTotal,
        });
      }

      totalMeters += meters * quantity;
      totalDiscount += lineDiscount;
      grandTotal += itemTotal;

      invoiceItemsData.push({
        inventory_item_id: inventoryItem.id,
        quantity,
        barcode: inventoryItem.barcode || null,
        item_name: inventoryItem.item_name,
        item_name_ar: inventoryItem.item_name_ar,
        fabric_type: inventoryItem.fabric_type || null,
        color: inventoryItem.color || null,
        unit: inventoryItem.unit || "meter",
        meters,
        cost_per_meter_snapshot: parseFloat(inventoryItem.cost_per_meter || 0),
        price_per_meter: pricePerMeter,
        discount: lineDiscount,
        total_price: itemTotal,
      });

      inventoryItem.quantity = stock.quantity;
      inventoryItem.length_m = stock.length_m;
      inventoryItem.status = stock.status;
      await inventoryItem.save({ transaction: t });
    }

    const totalPaid = payments.reduce((acc, p) => {
      const amount = parseFloat(p.amount);
      return acc + (isNaN(amount) ? 0 : amount);
    }, 0);

    logger.info("Payment validation", {
      component: "sales",
      totalPaid,
      grandTotal,
      difference: Math.abs(totalPaid - grandTotal),
      tolerance: 0.01,
    });

    const tolerance = Math.max(0.01, grandTotal * 0.001);
    const paymentDifference = Math.abs(totalPaid - grandTotal);

    if (paymentDifference > tolerance) {
      throw new Error(
        `Payment mismatch. Total paid: ${totalPaid.toFixed(3)} KWD, Grand total: ${grandTotal.toFixed(3)} KWD, Difference: ${paymentDifference.toFixed(3)} KWD.`,
      );
    }

    if (isNaN(totalPaid) || isNaN(grandTotal)) {
      throw new Error(
        "Invalid payment calculation. Please check item prices and payment amounts.",
      );
    }

    let invoiceNumber;
    if (invoiceBranchId) {
      let isUnique = false;
      while (!isUnique) {
        const results = await sequelize.query(
          `UPDATE "${schema}".branches SET next_invoice_sequence = next_invoice_sequence + 1 WHERE id = :branchId RETURNING next_invoice_sequence`,
          {
            replacements: { branchId: invoiceBranchId },
            transaction: t,
          }
        );

        const seqRaw = results[0]?.[0]?.next_invoice_sequence;
        if (!seqRaw) {
          const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
          invoiceNumber = `INV-${Date.now()}-${randomHex}`;
          break;
        }

        const seqNum = seqRaw - 1;
        invoiceNumber = `INV-${invoiceBranchId}-${seqNum}`;

        const existingInvoice = await Invoice.schema(schema).findOne({
          where: sequelize.where(
            sequelize.fn('lower', sequelize.col('invoice_number')),
            invoiceNumber.toLowerCase()
          ),
          transaction: t
        });

        if (!existingInvoice) {
          isUnique = true;
        }
      }
    } else {
      const randomHex = crypto.randomBytes(3).toString('hex').toUpperCase();
      invoiceNumber = `INV-${Date.now()}-${randomHex}`;
    }
    const newInvoice = await Invoice.schema(schema).create(
      {
        invoice_number: invoiceNumber,
        customer_id,
        total_meters: totalMeters,
        total_discount: totalDiscount,
        total_amount: grandTotal,
        notes,
        branch_id: invoiceBranchId,
        created_by: req.user.id,
      },
      { transaction: t },
    );

    await InvoiceItem.schema(schema).bulkCreate(
      invoiceItemsData.map((itemData) => ({
        invoice_id: newInvoice.id,
        ...itemData,
      })),
      { transaction: t },
    );
    await InvoicePayment.schema(schema).bulkCreate(
      payments.map((payment) => ({
        invoice_id: newInvoice.id,
        ...payment,
      })),
      { transaction: t },
    );

    await t.commit();
    await invalidateDashboardCache(req.tenant.slug);

    newInvoice.payments = payments;
    let pdfResult = {};

    const invoiceBranch = await Branch.schema(schema).findByPk(
      newInvoice.branch_id,
    );
    const branchLogoUrl = invoiceBranch?.logo_url || null;
    const invoiceBranchName = invoiceBranch?.name || branchName;

    const storeSettings = {
      name: req.tenant.name,
      phone: req.tenant.phone,
      branchLocation: invoiceBranch?.location,
      branchPhone: invoiceBranch?.phone
    };

    try {
      pdfResult = await generateInvoicePDF(
        newInvoice,
        invoiceItemsData,
        customer,
        user,
        invoiceBranchName,
        storeSettings,
        branchLogoUrl
      );

      if (pdfResult?.localPath) {
        newInvoice.pdf_path = pdfResult.localPath;
        await newInvoice.save();
      }
    } catch (fileError) {
      logger.error("File Generation Error", {
        component: "sales",
        error: fileError?.message,
        stack: fileError?.stack,
      });
    }

    const fullInvoice = await Invoice.schema(schema).findByPk(newInvoice.id, {
      include: [
        { model: InvoiceItem.schema(schema), as: "items" },
        { model: InvoicePayment.schema(schema), as: "payments" },
        { model: Customer.schema(schema), as: "customer" },
        { model: Branch.schema(schema), as: "branch", attributes: ["id", "name", "location", "phone", "logo_url"] },
        { model: User.schema(schema), as: "creator", attributes: ["full_name"] },
      ],
    });

    const branchWhatsappInvoiceEnabled = !!invoiceBranch?.whatsapp_invoice_enabled;
    const branchWhatsappInvoiceToStoreEnabled =
      !!invoiceBranch?.whatsapp_invoice_to_store_enabled;
    const branchWhatsappInvoiceToStorePhone =
      invoiceBranch?.whatsapp_invoice_to_store_phone || null;

    logger.info("Checking auto-send to store owner", {
      component: "sales",
      invoiceId: newInvoice.id,
      branchId: newInvoice.branch_id,
      enabled: branchWhatsappInvoiceToStoreEnabled,
      hasPhone: !!branchWhatsappInvoiceToStorePhone,
      phoneLength: branchWhatsappInvoiceToStorePhone?.length || 0,
    });

    if (
      branchWhatsappInvoiceToStoreEnabled &&
      branchWhatsappInvoiceToStorePhone
    ) {

      const normalizedStorePhone = branchWhatsappInvoiceToStorePhone.trim();
      if (normalizedStorePhone && normalizedStorePhone.length >= 8) {

        let pdfBuffer = pdfResult?.buffer;
        if (!pdfBuffer && pdfResult?.localPath) {
          try {
            pdfBuffer = await fs.promises.readFile(pdfResult.localPath);
          } catch (readErr) {
            if (readErr?.code !== "ENOENT") {
              logger.warn("Failed to read generated invoice PDF from disk", {
                component: "sales",
                invoiceId: newInvoice.id,
                error: readErr?.message,
              });
            }
          }
        }

        if (pdfBuffer) {
          const fileName = `invoice-${newInvoice.invoice_number}.pdf`;
          const caption = `New Invoice: ${newInvoice.invoice_number} - ${customer.full_name || "Customer"}`;
          try {
            if (isRedisEnabled()) {
              const jobId = await enqueueTransactionalDocument({
                tenantSlug: req.tenant.slug,
                phone: normalizedStorePhone,
                pdfBuffer,
                fileName,
                caption,
                branchId: newInvoice.branch_id,
                invoiceNumber: newInvoice.invoice_number,
              });
              logger.info("Invoice auto-send queued for store owner", {
                component: "sales",
                jobId,
                invoiceId: newInvoice.id,
                invoiceNumber: newInvoice.invoice_number,
                branchId: newInvoice.branch_id,
              });
            } else {
              const { sendWhatsAppDocument } = await import(
                "../../utils/whatsapp.service.js"
              );
              void sendWhatsAppDocument(
                req.tenant.slug,
                normalizedStorePhone,
                pdfBuffer,
                fileName,
                caption,
                newInvoice.branch_id,
              ).catch((waError) => {
                logger.error("Error auto-sending invoice to store owner", {
                  component: "sales",
                  error: waError?.message,
                  invoiceId: newInvoice.id,
                  branchId: newInvoice.branch_id,
                });
              });
            }
          } catch (waError) {
            logger.error("Failed to queue/send invoice to store owner", {
              component: "sales",
              error: waError?.message,
              invoiceId: newInvoice.id,
              branchId: newInvoice.branch_id,
            });
          }
        } else {
          logger.warn("PDF buffer not available for auto-send to store owner", {
            component: "sales",
            invoiceId: newInvoice.id,
            branchId: newInvoice.branch_id,
            hasLocalPath: !!pdfResult?.localPath,
          });
        }
      } else {
        logger.warn("Invalid store phone number for auto-send", {
          component: "sales",
          invoiceId: newInvoice.id,
          branchId: newInvoice.branch_id,
          phoneLength: normalizedStorePhone?.length || 0,
        });
      }
    }

    res.status(201).json({
      success: true,
      message: "Sale completed successfully.",
      data: {
        invoice: fullInvoice,
        items: invoiceItemsData,
        pdf_url: pdfResult?.cloudUrl || null,
        local_pdf: pdfResult?.localPath || null,
        branch_whatsapp_invoice_enabled: branchWhatsappInvoiceEnabled,
      },
    });
  } catch (error) {
    if (t && !t.finished) {
      try {
        await t.rollback();
      } catch (rollbackError) {
        logger.error("Transaction rollback error", {
          component: "sales",
          error: rollbackError?.message,
          stack: rollbackError?.stack,
        });
      }
    }
    logger.error("Create sale error", {
      component: "sales",
      error: error?.message,
      stack: error?.stack,
      userId: req.user?.id,
      requestId: req.requestId,
    });
    const message = error.message || "Failed to create sale. Please try again.";
    res.status(400).json({ message });
  }
};

