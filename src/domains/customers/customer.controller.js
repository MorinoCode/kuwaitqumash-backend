import Customer from "./customer.model.js";
import Invoice from "../sales/invoice.model.js";
import sequelize from "../../config/database.js";
import InvoiceItem from "../sales/invoice-item.model.js";
import InventoryItem from "../inventory/item.model.js";
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
        { phone: { [Op.like]: `%${search}%` } },
        { address: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    const totalCount = await Customer.schema(schema).count({
      where: whereClause,
    });

    const customers = await Customer.schema(schema).findAll({
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
    });

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

    const customer = await Customer.schema(schema).findByPk(id);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const invoices = await Invoice.schema(schema).findAll({
      where: {
        customer_id: id,
        status: { [Op.in]: ["Paid", "Partially Refunded"] },
      },
      include: [
        {
          model: InvoiceItem.schema(schema),
          as: "items",
          include: [
            {
              model: InventoryItem.schema(schema),
              as: "inventory_item",
              attributes: ["fabric_type", "pattern"],
            },
          ],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

    if (invoices.length === 0) {
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

    let totalSpent = 0;
    let totalItems = 0;
    let totalMeters = 0;
    let totalProfit = 0;
    const fabricCount = {};
    const patternCount = {};
    const purchaseDates = [];
    const purchaseAmounts = [];
    const dayOfWeekCount = {};
    const monthCount = {};

    invoices.forEach((inv) => {
      totalSpent += parseFloat(inv.total_amount || 0);
      purchaseAmounts.push(parseFloat(inv.total_amount || 0));
      purchaseDates.push(new Date(inv.createdAt));

      const dayOfWeek = new Date(inv.createdAt).getDay();
      dayOfWeekCount[dayOfWeek] = (dayOfWeekCount[dayOfWeek] || 0) + 1;

      const month = new Date(inv.createdAt).getMonth();
      monthCount[month] = (monthCount[month] || 0) + 1;

      (inv.items || []).forEach((item) => {
        const qty = parseInt(item.quantity, 10) || 1;
        const itemMeters = parseFloat(item.meters || 0);
        totalItems += qty;
        totalMeters += itemMeters * qty;

        const fabricType =
          item.fabric_type || item.inventory_item?.fabric_type || "Other";
        if (fabricType) {
          fabricCount[fabricType] = (fabricCount[fabricType] || 0) + qty;
        }

        const pattern = item.inventory_item?.pattern;
        if (pattern) {
          patternCount[pattern] = (patternCount[pattern] || 0) + qty;
        }

        const costPerMeter = parseFloat(item.cost_per_meter_snapshot || 0);
        const sellPrice = parseFloat(item.total_price || 0);
        totalProfit += sellPrice - costPerMeter * itemMeters * qty;
      });
    });

    const preferredFabric = Object.keys(fabricCount).reduce(
      (a, b) => (fabricCount[a] > fabricCount[b] ? a : b),
      Object.keys(fabricCount)[0] || null,
    );

    const preferredPattern = Object.keys(patternCount).reduce(
      (a, b) => (patternCount[a] > patternCount[b] ? a : b),
      Object.keys(patternCount)[0] || null,
    );

    const avgPurchaseValue = totalSpent / invoices.length;

    let avgDaysBetweenPurchases = 0;
    if (purchaseDates.length > 1) {
      const daysBetween = [];
      for (let i = 1; i < purchaseDates.length; i++) {
        const diff =
          (purchaseDates[i] - purchaseDates[i - 1]) / (1000 * 60 * 60 * 24);
        daysBetween.push(diff);
      }
      avgDaysBetweenPurchases =
        daysBetween.reduce((a, b) => a + b, 0) / daysBetween.length;
    }

    const bestDayOfWeek = Object.keys(dayOfWeekCount).reduce(
      (a, b) => (dayOfWeekCount[a] > dayOfWeekCount[b] ? a : b),
      Object.keys(dayOfWeekCount)[0] || null,
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

    const bestMonth = Object.keys(monthCount).reduce(
      (a, b) => (monthCount[a] > monthCount[b] ? a : b),
      Object.keys(monthCount)[0] || null,
    );
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

    let customerType = "new_customer";
    if (invoices.length >= 10) {
      customerType = "vip_customer";
    } else if (invoices.length >= 5) {
      customerType = "regular_customer";
    } else if (invoices.length >= 2) {
      customerType = "returning_customer";
    }

    const insights = [];

    if (invoices.length >= 3) {
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

    const recentMonths = purchaseDates
      .slice(-3)
      .map((d) => new Date(d).getMonth());
    const uniqueMonths = [...new Set(recentMonths)];
    if (uniqueMonths.length === 3) {
      insights.push("consistent_buyer");
    }

    const holidayMonths = [10, 11, 0];
    const holidayPurchases = purchaseDates.filter((d) =>
      holidayMonths.includes(new Date(d).getMonth()),
    ).length;
    if (holidayPurchases > purchaseDates.length * 0.4) {
      insights.push("holiday_shopper");
    }

    res.json({
      success: true,
      data: {
        analysis: {
          customer_type: customerType,
          insights: insights,
          preferences: {
            preferred_fabric_type: preferredFabric ? preferredFabric : null,
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
            best_buying_day: dayNames[bestDayOfWeek] || null,
            best_buying_month: monthNames[bestMonth] || null,
            purchase_frequency: invoices.length,
            last_purchase:
              purchaseDates.length > 0
                ? purchaseDates[purchaseDates.length - 1]
                : null,
            first_purchase: purchaseDates.length > 0 ? purchaseDates[0] : null,
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
