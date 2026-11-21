import sequelize from "../../config/database.js";
import Invoice from "./invoice.model.js";
import InvoiceItem from "./invoice-item.model.js";
import InvoicePayment from "./payment.model.js";
import InventoryItem from "../inventory/item.model.js";
import Customer from "../customers/customer.model.js";
import User from "../auth/user.model.js";
import logger from "../../utils/logger.js";
import { generateInvoicePDF, streamSalesExcel } from "../../utils/invoiceGenerator.js";
import { Op } from "sequelize";
import Branch from "../store/branch.model.js";
import { startOfKuwaitDay, endOfKuwaitDay } from "../../utils/kuwaitTime.js";

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
        const start = startOfKuwaitDay(start_date);
        const end = endOfKuwaitDay(end_date);
        whereClause.createdAt = { [Op.between]: [start, end] };
      } else {
        const dateRange = {};
        if (start_date) {
          dateRange[Op.gte] = startOfKuwaitDay(start_date);
        }
        if (end_date) {
          dateRange[Op.lte] = endOfKuwaitDay(end_date);
        }
        whereClause.createdAt = dateRange;
      }
    } else if (date) {
      const startDate = startOfKuwaitDay(date);
      const endDate = endOfKuwaitDay(date);
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

    let countPromise;

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

      countPromise = sequelize
        .query(countQuery, {
          bind: params,
          type: sequelize.QueryTypes.SELECT,
        })
        .then(([countResult]) => parseInt(countResult?.count || 0, 10));
    } else {
      countPromise = Invoice.schema(schema).count({ where: whereClause });
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

    const [totalCount, invoices] = await Promise.all([
      countPromise,
      Invoice.schema(schema).findAll(findOptions),
    ]);

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
        { model: Branch.schema(schema), as: "branch", attributes: ["id", "name", "location", "phone"] },
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
    const safeDisposition = req.query.disposition === "inline" ? "inline" : "attachment";

    if (!id || isNaN(id)) {
      return res.status(400).json({ message: "Invalid invoice ID" });
    }

    const invoice = await Invoice.schema(schema).findByPk(id, {
      include: [
        { model: InvoiceItem.schema(schema), as: "items" },
        { model: InvoicePayment.schema(schema), as: "payments" },
        { model: Customer.schema(schema), as: "customer" },
        { model: Branch.schema(schema), as: "branch", attributes: ["id", "name", "location", "phone"] },
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
      `${safeDisposition}; filename="invoice-${invoice.invoice_number}.pdf"`,
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


export const downloadSalesExcel = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { branch_ids, branch_id, start_date, end_date } = req.query;
    const whereClause = {};

    if (req.user.role === "store_owner") {
      const rawBranchFilter = branch_ids || branch_id;
      if (rawBranchFilter && rawBranchFilter !== "null" && rawBranchFilter !== "undefined") {
        const branchIdArray = String(rawBranchFilter)
          .split(",")
          .map((id) => parseInt(id.trim(), 10))
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
        dateRange[Op.gte] = startOfKuwaitDay(start_date);
      }
      if (end_date) {
        dateRange[Op.lte] = endOfKuwaitDay(end_date);
      }
      whereClause.createdAt = dateRange;
    }

    const MAX_EXPORT_ROWS = Number(process.env.SALES_EXCEL_MAX_ROWS) || 20000;
    const totalCount = await Invoice.schema(schema).count({
      where: whereClause,
    });

    if (totalCount > MAX_EXPORT_ROWS) {
      return res.status(400).json({
        success: false,
        message: `This range contains ${totalCount.toLocaleString()} invoices; the Excel export is limited to ${MAX_EXPORT_ROWS.toLocaleString()}. Please narrow the date range.`,
        total_count: totalCount,
        max_rows: MAX_EXPORT_ROWS,
      });
    }

    const fetchPage = (limit, offset) =>
      Invoice.schema(schema).findAll({
        where: whereClause,
        include: [
          {
            model: Customer.schema(schema),
            as: "customer",
            attributes: ["full_name", "phone", "address", "type"],
          },
          {
            model: User.schema(schema),
            as: "creator",
            attributes: ["full_name"],
          },
          { model: InvoicePayment.schema(schema), as: "payments" },
        ],
        order: [["createdAt", "DESC"]],
        limit,
        offset,
      });

    let filename = "sales-report";
    if (start_date && end_date) {
      filename = `sales-report-${start_date}_to_${end_date}`;
    } else if (start_date) {
      filename = `sales-report-from_${start_date}`;
    } else if (end_date) {
      filename = `sales-report-until_${end_date}`;
    }

    const written = await streamSalesExcel({
      res,
      filename,
      fetchPage,
      totalCount,
    });

    logger.info("Sales excel streamed", {
      component: "sales",
      tenant: req.tenant.slug,
      rows: written,
      requestId: req.requestId,
    });
  } catch (error) {
    logger.error("Excel generation error", {
      component: "sales",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
    });

    if (res.headersSent) {
      return res.end();
    }

    res
      .status(500)
      .json({ message: "Excel generation failed. Please try again." });
  }
};
