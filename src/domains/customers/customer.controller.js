import Customer from "./customer.model.js";
import Invoice from "../sales/invoice.model.js";
import sequelize from "../../config/database.js";
import InvoiceItem from "../sales/invoice-item.model.js";
import { Op } from "sequelize";
import { normalizeToLatinDigits } from "../../utils/normalizeNumbers.js";
import logger from "../../utils/logger.js";

const CUSTOMER_FIELDS = [
  "full_name",
  "phone",
  "gender",
  "address",
  "type",
  "notes",
  "branch_id",
];

const pickCustomerFields = (body = {}) => {
  const data = {};
  CUSTOMER_FIELDS.forEach((field) => {
    if (body[field] !== undefined) data[field] = body[field];
  });
  return data;
};

export const createCustomer = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;

    const data = pickCustomerFields(req.body);
    data.full_name = String(data.full_name || "").trim();
    data.phone = normalizeToLatinDigits(String(data.phone || "")).trim();

    const finalBranchId =
      req.user.role === "store_owner" && data.branch_id
        ? data.branch_id
        : req.user.branch_id;

    const newCustomer = await Customer.schema(schema).create({
      full_name: data.full_name,
      phone: data.phone,
      gender: data.gender || "M",
      address: data.address || null,
      type: data.type || "Regular",
      notes: data.notes || null,
      branch_id: finalBranchId,
      created_by: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: "Customer registered successfully",
      data: newCustomer,
    });
  } catch (error) {
    logger.error("Create customer error", {
      component: "customers",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
    });
    res
      .status(500)
      .json({ message: "Failed to create customer. Please try again." });
  }
};

export const getCustomers = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { search, branch_id, page = 1, limit = 20 } = req.query;
    const whereClause = {};

    if (req.user.role !== "store_owner") {
      whereClause.branch_id = req.user.branch_id;
    } else if (branch_id) {
      whereClause.branch_id = branch_id;
    }

    if (search) {
      whereClause[Op.or] = [
        { full_name: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.iLike]: `%${search}%` } },
        { address: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    const [totalCount, customers] = await Promise.all([
      Customer.schema(schema).count({
        where: whereClause,
      }),
      Customer.schema(schema).findAll({
        where: whereClause,
        attributes: [
          "id",
          "full_name",
          "phone",
          "gender",
          "address",
          "type",
          "notes",
          "branch_id",
          "created_at",
        ],
        order: [["createdAt", "DESC"]],
        limit: limitNum,
        offset: offset,
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      data: customers,
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
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getCustomerById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const customer = await Customer.schema(schema).findByPk(id);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const [statsQuery, refundStats] = await Promise.all([
      Invoice.schema(schema).findOne({
        where: {
          customer_id: id,
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
        },
        attributes: [
          [sequelize.fn("COUNT", sequelize.col("id")), "invoice_count"],
          [sequelize.fn("SUM", sequelize.col("total_amount")), "total_spent"],
          [sequelize.fn("MAX", sequelize.col("created_at")), "last_purchase"],
        ],
        raw: true,
      }),
      sequelize.query(
        `
        SELECT COALESCE(SUM(r.total_amount), 0) AS refunded_total
        FROM "${schema}".refunds r
        INNER JOIN "${schema}".invoices inv ON r.invoice_id = inv.id
        WHERE inv.customer_id = :customerId
          AND inv.status = 'Partially Refunded'
          AND r.status = 'Completed'
        `,
        {
          replacements: { customerId: id },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
    ]);

    const grossSpent = parseFloat(statsQuery?.total_spent || 0);
    const refundedTotal = parseFloat(refundStats?.[0]?.refunded_total || 0);
    const netSpent = Math.max(0, grossSpent - refundedTotal);

    const history = await Invoice.schema(schema).findAll({
      where: { customer_id: id },
      include: [{ model: InvoiceItem.schema(schema), as: "items" }],
      order: [["createdAt", "DESC"]],
      limit: 10,
    });

    res.json({
      success: true,
      data: {
        customer,
        history,
        stats: {
          total_spent: netSpent.toFixed(3),
          invoice_count: parseInt(statsQuery?.invoice_count || 0),
          last_purchase: statsQuery?.last_purchase || null,
        },
      },
    });
  } catch (error) {
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getCustomerAnalytics = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    if (!/^[a-zA-Z0-9_]+$/.test(schema)) {
      return res.status(400).json({ message: "Invalid tenant schema" });
    }

    const customerId = parseInt(id, 10);
    if (!Number.isInteger(customerId) || customerId <= 0) {
      return res.status(400).json({ message: "Invalid customer ID" });
    }

    const customer = await Customer.schema(schema).findByPk(customerId);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    // Aggregate customer analytics directly inside PostgreSQL in Kuwait timezone
    // (net of Completed refunds) to avoid loading full purchase history into RAM.
    const replacements = { customerId };
    const queryOpts = { replacements, type: sequelize.QueryTypes.SELECT };

    const [
      [summaryRow = {}],
      [refundRow = {}],
      [itemRow = {}],
      prefRows,
      [bestDayRow],
      [bestMonthRow],
      recentMonthRows,
    ] = await Promise.all([
      sequelize.query(
        `
        SELECT
          COUNT(inv.id)::int AS purchase_frequency,
          COALESCE(SUM(inv.total_amount), 0) AS gross_spent,
          MIN(inv.created_at) AS first_purchase,
          MAX(inv.created_at) AS last_purchase,
          COUNT(*) FILTER (
            WHERE EXTRACT(MONTH FROM (inv.created_at AT TIME ZONE 'Asia/Kuwait'))::int IN (11, 12, 1)
          )::int AS holiday_purchases,
          CASE
            WHEN COUNT(inv.id) > 1
            THEN EXTRACT(EPOCH FROM (MAX(inv.created_at) - MIN(inv.created_at))) / 86400.0 / (COUNT(inv.id) - 1)
            ELSE 0
          END AS avg_days_between_purchases
        FROM "${schema}".invoices inv
        WHERE inv.customer_id = :customerId
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        queryOpts,
      ),
      sequelize.query(
        `
        SELECT
          COALESCE(SUM(r.total_amount), 0) AS refunded_amount,
          COALESCE((
            SELECT SUM(COALESCE(ri.quantity_refunded, 1))
            FROM "${schema}".refund_items ri
            INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
            INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
            WHERE inv2.customer_id = :customerId
              AND inv2.status = 'Partially Refunded'
              AND r2.status = 'Completed'
          ), 0)::int AS refunded_items,
          COALESCE((
            SELECT SUM(COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
            FROM "${schema}".refund_items ri
            INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
            INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
            WHERE inv2.customer_id = :customerId
              AND inv2.status = 'Partially Refunded'
              AND r2.status = 'Completed'
          ), 0) AS refunded_meters,
          COALESCE((
            SELECT SUM(COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
            FROM "${schema}".refund_items ri
            INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
            INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
            LEFT JOIN "${schema}".invoice_items it ON ri.invoice_item_id = it.id
            WHERE inv2.customer_id = :customerId
              AND inv2.status = 'Partially Refunded'
              AND r2.status = 'Completed'
          ), 0) AS refunded_cost
        FROM "${schema}".refunds r
        INNER JOIN "${schema}".invoices inv ON r.invoice_id = inv.id
        WHERE inv.customer_id = :customerId
          AND inv.status = 'Partially Refunded'
          AND r.status = 'Completed'
        `,
        queryOpts,
      ),
      sequelize.query(
        `
        SELECT
          COALESCE(SUM(COALESCE(it.quantity, 1)), 0)::int AS total_items,
          COALESCE(SUM(COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) AS total_meters,
          COALESCE(SUM(COALESCE(it.total_price, 0)), 0) AS gross_item_sell,
          COALESCE(SUM(COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) AS gross_cost
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON inv.id = it.invoice_id
        WHERE inv.customer_id = :customerId
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        queryOpts,
      ),
      sequelize.query(
        `
        SELECT
          COALESCE(NULLIF(it.fabric_type, ''), NULLIF(ii.fabric_type, ''), 'Other') AS fabric_type,
          ii.pattern AS pattern,
          COALESCE(SUM(COALESCE(it.quantity, 1)), 0)::int AS total_qty
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON inv.id = it.invoice_id
        LEFT JOIN "${schema}".inventory_items ii ON ii.id = it.inventory_item_id
        WHERE inv.customer_id = :customerId
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY 1, 2
        `,
        queryOpts,
      ),
      sequelize.query(
        `
        SELECT
          EXTRACT(DOW FROM (inv.created_at AT TIME ZONE 'Asia/Kuwait'))::int AS day_of_week,
          COUNT(*)::int AS cnt
        FROM "${schema}".invoices inv
        WHERE inv.customer_id = :customerId
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY 1
        ORDER BY cnt DESC, day_of_week ASC
        LIMIT 1
        `,
        queryOpts,
      ),
      sequelize.query(
        `
        SELECT
          (EXTRACT(MONTH FROM (inv.created_at AT TIME ZONE 'Asia/Kuwait'))::int - 1) AS month_idx,
          COUNT(*)::int AS cnt
        FROM "${schema}".invoices inv
        WHERE inv.customer_id = :customerId
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY 1
        ORDER BY cnt DESC, month_idx ASC
        LIMIT 1
        `,
        queryOpts,
      ),
      sequelize.query(
        `
        SELECT
          (EXTRACT(MONTH FROM (inv.created_at AT TIME ZONE 'Asia/Kuwait'))::int - 1) AS month_idx
        FROM "${schema}".invoices inv
        WHERE inv.customer_id = :customerId
          AND inv.status IN ('Paid', 'Partially Refunded')
        ORDER BY inv.created_at DESC
        LIMIT 3
        `,
        queryOpts,
      ),
    ]);

    const purchaseFrequency = Number(summaryRow.purchase_frequency || 0);
    if (purchaseFrequency === 0) {
      return res.json({
        success: true,
        data: {
          analysis: {
            customer_type: "new_customer",
            insights: [],
            preferences: {},
            behavior: {},
          },
        },
      });
    }

    const grossSpent = parseFloat(summaryRow.gross_spent || 0);
    const refundedAmount = parseFloat(refundRow.refunded_amount || 0);
    const totalSpent = Math.max(0, grossSpent - refundedAmount);

    const grossItems = Number(itemRow.total_items || 0);
    const refundedItems = Number(refundRow.refunded_items || 0);
    const totalItems = Math.max(0, grossItems - refundedItems);

    const grossMeters = parseFloat(itemRow.total_meters || 0);
    const refundedMeters = parseFloat(refundRow.refunded_meters || 0);
    const totalMeters = Math.max(0, grossMeters - refundedMeters);

    const grossItemSell = parseFloat(itemRow.gross_item_sell || 0);
    const grossCost = parseFloat(itemRow.gross_cost || 0);
    const refundedCost = parseFloat(refundRow.refunded_cost || 0);
    const netCost = Math.max(0, grossCost - refundedCost);
    const totalProfit = grossItemSell - refundedAmount - netCost;

    const fabricCount = {};
    const patternCount = {};
    for (const row of prefRows) {
      const qty = Number(row.total_qty || 0);
      if (row.fabric_type) {
        fabricCount[row.fabric_type] = (fabricCount[row.fabric_type] || 0) + qty;
      }
      if (row.pattern) {
        patternCount[row.pattern] = (patternCount[row.pattern] || 0) + qty;
      }
    }

    const fabricKeys = Object.keys(fabricCount);
    const preferredFabric = fabricKeys.length
      ? fabricKeys.reduce((a, b) => (fabricCount[a] > fabricCount[b] ? a : b))
      : null;

    const patternKeys = Object.keys(patternCount);
    const preferredPattern = patternKeys.length
      ? patternKeys.reduce((a, b) => (patternCount[a] > patternCount[b] ? a : b))
      : null;

    const avgPurchaseValue = totalSpent / purchaseFrequency;
    const avgDaysBetweenPurchases = parseFloat(
      summaryRow.avg_days_between_purchases || 0,
    );

    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    const bestDayOfWeek =
      bestDayRow?.day_of_week != null ? Number(bestDayRow.day_of_week) : null;
    const bestMonth =
      bestMonthRow?.month_idx != null ? Number(bestMonthRow.month_idx) : null;

    let customerType = "new_customer";
    if (purchaseFrequency >= 10) {
      customerType = "vip_customer";
    } else if (purchaseFrequency >= 5) {
      customerType = "regular_customer";
    } else if (purchaseFrequency >= 2) {
      customerType = "returning_customer";
    }

    const insights = [];

    if (purchaseFrequency >= 3) {
      insights.push("frequent_buyer");
    }

    if (preferredFabric) {
      insights.push(`prefers_${preferredFabric}_items`);
    }

    if (avgDaysBetweenPurchases > 0 && avgDaysBetweenPurchases < 30) {
      insights.push("active_shopper");
    }

    if (avgPurchaseValue > 100) {
      insights.push("high_value_customer");
    }

    if (totalSpent > 0 && totalProfit / totalSpent > 0.3) {
      insights.push("profitable_customer");
    }

    const uniqueRecentMonths = new Set(
      recentMonthRows.map((r) => Number(r.month_idx)),
    );
    if (uniqueRecentMonths.size === 3) {
      insights.push("consistent_buyer");
    }

    const holidayPurchases = Number(summaryRow.holiday_purchases || 0);
    if (holidayPurchases > purchaseFrequency * 0.4) {
      insights.push("holiday_shopper");
    }

    res.json({
      success: true,
      data: {
        analysis: {
          customer_type: customerType,
          insights: insights,
          preferences: {
            preferred_fabric_type: preferredFabric || null,
            preferred_pattern: preferredPattern || null,
            fabric_distribution: fabricCount,
            pattern_distribution: patternCount,
          },
          behavior: {
            total_spent: totalSpent.toFixed(3),
            total_items: totalItems,
            total_meters: totalMeters.toFixed(3),
            total_profit: totalProfit.toFixed(3),
            avg_purchase_value: avgPurchaseValue.toFixed(3),
            avg_days_between_purchases: Math.round(avgDaysBetweenPurchases),
            best_buying_day:
              bestDayOfWeek !== null ? dayNames[bestDayOfWeek] || null : null,
            best_buying_month:
              bestMonth !== null ? monthNames[bestMonth] || null : null,
            purchase_frequency: purchaseFrequency,
            last_purchase: summaryRow.last_purchase
              ? new Date(summaryRow.last_purchase)
              : null,
            first_purchase: summaryRow.first_purchase
              ? new Date(summaryRow.first_purchase)
              : null,
          },
        },
      },
    });
  } catch (error) {
    logger.error("Customer Analytics Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process analytics. Please try again." });
  }
};

export const updateCustomer = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const customer = await Customer.schema(schema).findByPk(id);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const data = pickCustomerFields(req.body);
    if (data.phone != null) {
      data.phone = normalizeToLatinDigits(String(data.phone)).trim();
    }
    if (data.full_name != null) {
      data.full_name = String(data.full_name).trim();
    }

    await customer.update(data);
    res.json({
      success: true,
      message: "Updated successfully",
      data: customer,
    });
  } catch (error) {
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const deleteCustomer = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const customer = await Customer.schema(schema).findByPk(id);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const hasInvoices = await Invoice.schema(schema).findOne({
      where: { customer_id: id },
    });
    if (hasInvoices) {
      return res
        .status(400)
        .json({ message: "Cannot delete customer with purchase history." });
    }

    await customer.destroy();
    res.json({ success: true, message: "Deleted successfully" });
  } catch (error) {
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getCustomerHistory = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    const { count, rows: history } = await Invoice.schema(
      schema,
    ).findAndCountAll({
      where: { customer_id: id },
      include: [{ model: InvoiceItem.schema(schema), as: "items" }],
      order: [["createdAt", "DESC"]],
      limit: limitNum,
      offset: offset,
    });

    res.json({
      success: true,
      data: history,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(count / limitNum),
        totalItems: count,
        itemsPerPage: limitNum,
      },
    });
  } catch (error) {
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};
