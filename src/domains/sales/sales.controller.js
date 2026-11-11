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
import {
  generateInvoicePDF,
  generateSalesExcelBuffer,
} from "../../utils/invoiceGenerator.js";
import {
  sendInvoicePDF,
  sendWhatsAppDocument,
} from "../../utils/whatsapp.service.js";
import { Op } from "sequelize";
import Branch from "../store/branch.model.js";

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

    const invoiceBranchId = branch_id || req.user.branch_id || 1;

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

    for (const item of items) {
      const inventoryItem = await InventoryItem.schema(schema).findByPk(
        item.id,
        { transaction: t, lock: t.LOCK.UPDATE },
      );
      if (!inventoryItem) throw new Error(`Item with ID ${item.id} not found.`);

      if (
        req.user.role !== "store_owner" &&
        inventoryItem.branch_id !== req.user.branch_id &&
        inventoryItem.branch_id !== invoiceBranchId
      ) {
        throw new Error(`Item belongs to another branch.`);
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

      const pricePerMeter = parseFloat(item.price_per_meter);
      if (isNaN(pricePerMeter) || pricePerMeter <= 0) {
        throw new Error(
          "Invalid price per meter for item " + (item.id || inventoryItem.id),
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

      const [colCheck] = await sequelize.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema = :schema AND table_name = 'branches' AND column_name = 'next_invoice_sequence'`,
        { replacements: { schema }, transaction: t }
      );

      if (colCheck.length === 0) {
        await sequelize.query(
          `ALTER TABLE "${schema}".branches ADD COLUMN next_invoice_sequence INTEGER NOT NULL DEFAULT 1`,
          { transaction: t }
        );
      }

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

    for (const itemData of invoiceItemsData) {
      await InvoiceItem.schema(schema).create(
        { invoice_id: newInvoice.id, ...itemData },
        { transaction: t },
      );
    }
    for (const payment of payments) {
      await InvoicePayment.schema(schema).create(
        { invoice_id: newInvoice.id, ...payment },
        { transaction: t },
      );
    }

    await t.commit();

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
      ],
    });

    let branchWhatsappInvoiceEnabled = false;
    let branchWhatsappInvoiceToStoreEnabled = false;
    let branchWhatsappInvoiceToStorePhone = null;
    try {
      const branchId = newInvoice.branch_id;
      if (branchId) {
        const Branch = sequelize.models.Branch;
        const branch = await Branch.schema(schema).findByPk(branchId);
        if (branch) {
          branchWhatsappInvoiceEnabled = !!branch.whatsapp_invoice_enabled;
          branchWhatsappInvoiceToStoreEnabled =
            !!branch.whatsapp_invoice_to_store_enabled;
          branchWhatsappInvoiceToStorePhone =
            branch.whatsapp_invoice_to_store_phone;
        }
      }
    } catch (e) {
      logger.warn("Failed to fetch branch WhatsApp setting", {
        component: "sales",
        error: e?.message,
      });
    }

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
        if (
          !pdfBuffer &&
          pdfResult?.localPath &&
          fs.existsSync(pdfResult.localPath)
        ) {
          pdfBuffer = fs.readFileSync(pdfResult.localPath);
        }

        if (pdfBuffer) {
          try {
            const storeSendSuccess = await sendWhatsAppDocument(
              req.tenant.slug,
              normalizedStorePhone,
              pdfBuffer,
              `invoice-${newInvoice.invoice_number}.pdf`,
              `New Invoice: ${newInvoice.invoice_number} - ${customer.full_name || "Customer"}`,
              newInvoice.branch_id,
            );
            if (storeSendSuccess) {
              logger.info("Invoice auto-sent to store owner", {
                component: "sales",
                invoiceId: newInvoice.id,
                invoiceNumber: newInvoice.invoice_number,
                branchId: newInvoice.branch_id,
                storePhone:
                  normalizedStorePhone.substring(0, 4) +
                  "****" +
                  normalizedStorePhone.substring(
                    normalizedStorePhone.length - 2,
                  ),
              });
            } else {
              logger.warn("Failed to auto-send invoice to store owner", {
                component: "sales",
                invoiceId: newInvoice.id,
                branchId: newInvoice.branch_id,
                storePhone:
                  normalizedStorePhone.substring(0, 4) +
                  "****" +
                  normalizedStorePhone.substring(
                    normalizedStorePhone.length - 2,
                  ),
              });
            }
          } catch (waError) {
            logger.error("Error auto-sending invoice to store owner", {
              component: "sales",
              error: waError?.message,
              stack: waError?.stack,
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

export const getInvoices = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const {
      branch_id,
      branch_ids,
      search,
      date,
      start_date,
      end_date,
      page = 1,
      limit = 20,
    } = req.query;

    const whereClause = {};

    if (req.user.role === "store_owner") {

      if (branch_ids && branch_ids !== "null" && branch_ids !== "undefined") {

        const branchIdArray = branch_ids
          .split(",")
          .map((id) => parseInt(id.trim()))
          .filter((id) => !isNaN(id));
        if (branchIdArray.length > 0) {
          whereClause.branch_id = { [Op.in]: branchIdArray };
        }
      } else if (
        branch_id &&
        branch_id !== "null" &&
        branch_id !== "undefined"
      ) {

        whereClause.branch_id = branch_id;
      }
    } else {

      whereClause.branch_id = req.user.branch_id;
    }

    if (start_date || end_date) {

      if (start_date && end_date) {

        const [startYear, startMonth, startDay] = start_date
          .split("-")
          .map(Number);
        const [endYear, endMonth, endDay] = end_date.split("-").map(Number);
        const start = new Date(startYear, startMonth - 1, startDay, 0, 0, 0, 0);
        const end = new Date(endYear, endMonth - 1, endDay, 23, 59, 59, 999);
        whereClause.createdAt = { [Op.between]: [start, end] };
      } else {

        const dateRange = {};
        if (start_date) {
          const [year, month, day] = start_date.split("-").map(Number);
          const start = new Date(year, month - 1, day, 0, 0, 0, 0);
          dateRange[Op.gte] = start;
        }
        if (end_date) {
          const [year, month, day] = end_date.split("-").map(Number);
          const end = new Date(year, month - 1, day, 23, 59, 59, 999);
          dateRange[Op.lte] = end;
        }
        whereClause.createdAt = dateRange;
      }
    } else if (date) {

      const [year, month, day] = date.split("-").map(Number);
      const startDate = new Date(year, month - 1, day, 0, 0, 0, 0);
      const endDate = new Date(year, month - 1, day, 23, 59, 59, 999);
      whereClause.createdAt = { [Op.between]: [startDate, endDate] };
    }

    if (search) {
      const searchTerm = search.trim();

      const searchConditions = [

        { invoice_number: { [Op.iLike]: `${searchTerm}%` } },
        { "$customer.full_name$": { [Op.iLike]: `${searchTerm}%` } },
        { "$customer.phone$": { [Op.iLike]: `${searchTerm}%` } },

        { invoice_number: { [Op.iLike]: `%${searchTerm}%` } },
        { "$customer.full_name$": { [Op.iLike]: `%${searchTerm}%` } },
        { "$customer.phone$": { [Op.iLike]: `%${searchTerm}%` } },
      ];

      if (whereClause[Op.or]) {
        const branchFilter = { [Op.or]: whereClause[Op.or] };
        delete whereClause[Op.or];
        whereClause[Op.and] = [branchFilter, { [Op.or]: searchConditions }];
      } else {
        whereClause[Op.or] = searchConditions;
      }
    }

    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    let totalCount;

    if (search) {

      const searchTerm = `%${search}%`;
      const params = [];
      let paramIndex = 1;

      const conditions = [];

      if (whereClause.branch_id) {
        if (Array.isArray(whereClause.branch_id[Op.in])) {
          const placeholders = whereClause.branch_id[Op.in]
            .map(() => `$${paramIndex++}`)
            .join(",");
          params.push(...whereClause.branch_id[Op.in]);
          conditions.push(`i.branch_id IN (${placeholders})`);
        } else {
          conditions.push(`i.branch_id = $${paramIndex++}`);
          params.push(whereClause.branch_id);
        }
      }

      if (whereClause.createdAt) {
        if (whereClause.createdAt[Op.between]) {
          conditions.push(
            `i.created_at BETWEEN $${paramIndex++} AND $${paramIndex++}`,
          );
          params.push(
            whereClause.createdAt[Op.between][0],
            whereClause.createdAt[Op.between][1],
          );
        } else if (whereClause.createdAt[Op.gte]) {
          conditions.push(`i.created_at >= $${paramIndex++}`);
          params.push(whereClause.createdAt[Op.gte]);
        } else if (whereClause.createdAt[Op.lte]) {
          conditions.push(`i.created_at <= $${paramIndex++}`);
          params.push(whereClause.createdAt[Op.lte]);
        }
      }

      conditions.push(`(
        i.invoice_number ILIKE $${paramIndex++} OR
        c.full_name ILIKE $${paramIndex++} OR
        c.phone ILIKE $${paramIndex++}
      )`);
      params.push(searchTerm, searchTerm, searchTerm);

      const whereSQL =
        conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

      const countQuery = `
        SELECT COUNT(DISTINCT i.id) as count
        FROM "${schema}".invoices i
        LEFT JOIN "${schema}".customers c ON i.customer_id = c.id
        ${whereSQL}
      `;

      const [countResult] = await sequelize.query(countQuery, {
        bind: params,
        type: sequelize.QueryTypes.SELECT,
      });
      totalCount = parseInt(countResult?.count || 0, 10);
    } else {

      totalCount = await Invoice.schema(schema).count({ where: whereClause });
    }

    const findOptions = {
      where: whereClause,
      attributes: [
        "id",
        "invoice_number",
        "total_amount",
        "total_meters",
        "total_discount",
        "status",
        "notes",
        "createdAt",
        "updatedAt",
        "branch_id",
        "customer_id",
        "created_by",
      ],
      include: [
        {
          model: Customer.schema(schema),
          as: "customer",
          attributes: ["full_name", "phone"],
          required: false,
        },
        {
          model: User.schema(schema),
          as: "creator",
          attributes: ["full_name"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit: limitNum,
      offset: offset,
    };

    const invoices = await Invoice.schema(schema).findAll(findOptions);

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      data: invoices,
      count: invoices.length,
      pagination: {
        currentPage: pageNum,
        totalPages: totalPages,
        totalItems: totalCount,
        itemsPerPage: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    logger.error("Error in getInvoices", {
      component: "sales",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to fetch invoices. Please try again." });
  }
};

export const getInvoiceById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    if (!id || isNaN(id)) {
      return res.status(400).json({ message: "Invalid invoice ID" });
    }

    const invoice = await Invoice.schema(schema).findByPk(id, {
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

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    if (
      req.user.role !== "store_owner" &&
      invoice.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied to this invoice" });
    }

    res.json({ success: true, data: invoice });
  } catch (error) {
    logger.error("Get invoice PDF error", {
      component: "sales",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
      invoiceId: req?.params?.id,
    });
    res
      .status(500)
      .json({ message: "Failed to generate PDF. Please try again." });
  }
};

export const getInvoicePDF = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const { disposition = "attachment" } = req.query;

    if (!id || isNaN(id)) {
      return res.status(400).json({ message: "Invalid invoice ID" });
    }

    const invoice = await Invoice.schema(schema).findByPk(id, {
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

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    if (
      req.user.role !== "store_owner" &&
      invoice.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied to this invoice" });
    }

    const inventoryItemIds = invoice.items
      .map((item) => item.inventory_item_id)
      .filter((id) => id != null);

    const inventoryItems =
      inventoryItemIds.length > 0
        ? await InventoryItem.schema(schema).findAll({
            where: { id: { [Op.in]: inventoryItemIds } },
            attributes: ["id", "barcode", "rfid_tag", "quantity"],
          })
        : [];

    const inventoryMap = new Map(inventoryItems.map((item) => [item.id, item]));

    const itemsWithDetails = invoice.items.map((item) => {
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
      user = await User.schema(schema).findByPk(invoice.created_by, {
        include: [
          { model: sequelize.models.Branch.schema(schema), as: "branch" },
        ],
      });
    } catch (e) {
      void e;
      user = { full_name: "Cashier", id: invoice.created_by };
    }

    const branch = await sequelize.models.Branch.schema(schema).findByPk(
      invoice.branch_id,
    );
    const branchName =
      branch?.name || (user.branch ? user.branch.name : "Main Branch");
    const branchLogoUrl = branch?.logo_url || null;
    const storeSettings = {
      name: req.tenant.name,
      phone: req.tenant.phone,
      branchLocation: branch?.location,
      branchPhone: branch?.phone
    };

    const pdfResult = await generateInvoicePDF(
      invoice,
      itemsWithDetails,
      invoice.customer,
      user,
      branchName,
      storeSettings,
      branchLogoUrl,
    );

    if (!pdfResult || !pdfResult.buffer) {
      return res.status(500).json({ message: "PDF generation failed" });
    }

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${disposition}; filename="invoice-${invoice.invoice_number}.pdf"`,
    );
    res.send(pdfResult.buffer);
  } catch (error) {
    logger.error("PDF generation error", {
      component: "sales",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "PDF generation failed. Please try again." });
  }
};

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

    const targetPhone = phone || invoice.customer?.phone;
    if (!targetPhone) {
      return res.status(400).json({ message: "Phone number is required" });
    }

    let pdfPath = invoice.pdf_path;
    if (!pdfPath || !fs.existsSync(pdfPath)) {

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
        .filter((id) => id != null);

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
      } else {

        if (pdfResult?.buffer) {
          const success = await sendWhatsAppDocument(
            req.tenant.slug,
            targetPhone,
            pdfResult.buffer,
            `invoice-${invoice.invoice_number}.pdf`,
            `Invoice ${invoice.invoice_number}`,
            invoice.branch_id,
          );
          if (success) {
            return res.json({
              success: true,
              message: "Invoice sent via WhatsApp successfully",
            });
          } else {
            return res
              .status(500)
              .json({ message: "Failed to send invoice via WhatsApp" });
          }
        } else {
          return res
            .status(500)
            .json({ message: "PDF generation failed. Please try again." });
        }
      }
    }

    if (!pdfPath || !fs.existsSync(pdfPath)) {
      logger.error("PDF path invalid or file not found", {
        component: "sales",
        invoiceId: id,
        pdfPath,
        branchId: invoice.branch_id,
      });
      return res.status(500).json({
        message: "PDF file not found. Please regenerate the invoice PDF.",
      });
    }

    const success = await sendInvoicePDF(
      req.tenant.slug,
      targetPhone,
      pdfPath,
      `Invoice ${invoice.invoice_number}`,
      invoice.branch_id,
    );

    if (success) {
      res.json({
        success: true,
        message: "Invoice sent via WhatsApp successfully",
      });
    } else {
      logger.warn("sendInvoicePDF returned false", {
        component: "sales",
        invoiceId: id,
        branchId: invoice.branch_id,
        tenantSlug: req.tenant.slug,
      });
      res.status(500).json({
        message:
          "Failed to send invoice via WhatsApp. Please check WhatsApp connection.",
      });
    }
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

export const downloadSalesExcel = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { branch_ids, start_date, end_date } = req.query;
    const whereClause = {};

    if (req.user.role === "store_owner") {
      if (branch_ids && branch_ids !== "null" && branch_ids !== "undefined") {
        const branchIdArray = branch_ids
          .split(",")
          .map((id) => parseInt(id.trim()))
          .filter((id) => !isNaN(id));
        if (branchIdArray.length > 0) {
          whereClause.branch_id = { [Op.in]: branchIdArray };
        }
      }
    } else {
      whereClause.branch_id = req.user.branch_id;
    }

    if (start_date || end_date) {
      const dateRange = {};
      if (start_date) {
        const start = new Date(start_date);
        start.setHours(0, 0, 0, 0);
        dateRange[Op.gte] = start;
      }
      if (end_date) {
        const end = new Date(end_date);
        end.setHours(23, 59, 59, 999);
        dateRange[Op.lte] = end;
      }
      whereClause.createdAt = dateRange;
    }

    const invoices = await Invoice.schema(schema).findAll({
      where: whereClause,
      include: [
        {
          model: Customer.schema(schema),
          as: "customer",
          attributes: ["full_name", "phone", "civil_id"],
        },
        {
          model: User.schema(schema),
          as: "creator",
          attributes: ["full_name"],
        },
        { model: InvoicePayment.schema(schema), as: "payments" },
      ],
      order: [["createdAt", "DESC"]],
      limit: 10000,
    });

    const excelBuffer = await generateSalesExcelBuffer(invoices);

    let filename = "sales-report";
    if (start_date && end_date) {
      filename = `sales-report-${start_date}_to_${end_date}`;
    } else if (start_date) {
      filename = `sales-report-from_${start_date}`;
    } else if (end_date) {
      filename = `sales-report-until_${end_date}`;
    }

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${filename}.xlsx"`,
    );
    res.send(excelBuffer);
  } catch (error) {
    logger.error("Excel generation error", {
      component: "sales",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Excel generation failed. Please try again." });
  }
};
