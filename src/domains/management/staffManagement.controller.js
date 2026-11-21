import { Op } from "sequelize";;
import sequelize from "../../config/database.js";
import Branch from "../store/branch.model.js";
import User from "../auth/user.model.js";
import Invoice from "../sales/invoice.model.js";
import Customer from "../customers/customer.model.js";
import logger from "../../utils/logger.js";
import { invalidateAuthUserCache } from "../../middlewares/auth.middleware.js";;

export const createStaff = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    let { full_name, username, password, role, branch_id } = req.body;
    username = username.toLowerCase();

    if (
      req.user.role !== "store_owner" &&
      (role === "store_owner" || role === "branch_manager")
    ) {
      return res.status(403).json({
        message: "Access Denied: You cannot create Admins or Managers.",
      });
    }

    if (req.user.role === "branch_manager") {
      if (parseInt(branch_id) !== req.user.branch_id) {
        return res
          .status(403)
          .json({ message: "You can only add staff to your own branch." });
      }
    }

    const existingUser = await User.schema(schema).findOne({
      where: { username: { [Op.iLike]: username } },
    });
    if (existingUser) {
      return res.status(400).json({ message: "Username already exists" });
    }

    const newUser = await User.schema(schema).create({
      full_name,
      username,
      password: password,
      role,
      branch_id,
      is_active: true,
    });

    res.status(201).json({
      success: true,
      message: "Staff created successfully",
      data: { id: newUser.id, username: newUser.username },
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getStaff = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { page = 1, limit = 50, search } = req.query;
    const whereClause = { is_active: true };

    if (req.user.role === "branch_manager") {
      whereClause.branch_id = req.user.branch_id;
      whereClause.role = { [Op.not]: "store_owner" };
    }

    if (search) {
      whereClause[Op.or] = [
        { full_name: { [Op.iLike]: `%${search}%` } },
        { username: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    const [totalCount, staff] = await Promise.all([
      User.schema(schema).count({ where: whereClause }),
      User.schema(schema).findAll({
        where: whereClause,
        attributes: { exclude: ["password"] },
        include: [
          { model: Branch.schema(schema), as: "branch", attributes: ["name"] },
        ],
        order: [["createdAt", "DESC"]],
        limit: limitNum,
        offset: offset,
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      data: staff,
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
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getStaffById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const staffMember = await User.schema(schema).findByPk(id, {
      attributes: { exclude: ["password"] },
      include: [
        {
          model: Branch.schema(schema),
          as: "branch",
          attributes: ["name", "location"],
        },
      ],
    });

    if (!staffMember)
      return res.status(404).json({ message: "Staff not found" });

    if (
      req.user.role === "branch_manager" &&
      staffMember.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access Denied." });
    }

    const salesHistory = await Invoice.schema(schema).findAll({
      where: { created_by: id },
      include: [
        {
          model: Customer.schema(schema),
          as: "customer",
          attributes: ["full_name", "phone"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit: 50,
    });

    let totalSales = 0;
    salesHistory.forEach((inv) => {
      totalSales += parseFloat(inv.total_amount);
    });

    res.json({
      success: true,
      data: {
        staff: staffMember,
        history: salesHistory,
        stats: {
          total_sales_volume: totalSales.toFixed(3),
          total_invoices: salesHistory.length,
        },
      },
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getStaffAnalytics = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    if (!/^[a-zA-Z0-9_]+$/.test(schema)) {
      return res.status(400).json({ message: "Invalid tenant schema" });
    }

    const { id } = req.params;
    const staffId = parseInt(id, 10);
    if (!Number.isInteger(staffId) || staffId <= 0) {
      return res.status(400).json({ message: "Invalid staff ID" });
    }

    const staffMember = await User.schema(schema).findByPk(staffId, {
      attributes: { exclude: ["password"] },
    });

    if (!staffMember)
      return res.status(404).json({ message: "Staff not found" });

    if (
      req.user.role === "branch_manager" &&
      staffMember.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access Denied." });
    }

    // Aggregate all metrics directly inside PostgreSQL in Kuwait timezone
    // (net of Completed refunds) to avoid loading full invoice history into RAM.
    const replacements = { staffId };
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
          COUNT(inv.id)::int AS total_invoices,
          COALESCE(SUM(inv.total_amount), 0) AS gross_sales,
          COUNT(DISTINCT inv.customer_id)::int AS unique_customers,
          MIN(inv.created_at) AS first_sale,
          MAX(inv.created_at) AS last_sale,
          CASE
            WHEN COUNT(inv.id) > 1
            THEN EXTRACT(EPOCH FROM (MAX(inv.created_at) - MIN(inv.created_at))) / 86400.0 / (COUNT(inv.id) - 1)
            ELSE 0
          END AS avg_days_between_sales
        FROM "${schema}".invoices inv
        WHERE inv.created_by = :staffId
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
            WHERE inv2.created_by = :staffId
              AND inv2.status = 'Partially Refunded'
              AND r2.status = 'Completed'
          ), 0)::int AS refunded_items,
          COALESCE((
            SELECT SUM(COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
            FROM "${schema}".refund_items ri
            INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
            INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
            WHERE inv2.created_by = :staffId
              AND inv2.status = 'Partially Refunded'
              AND r2.status = 'Completed'
          ), 0) AS refunded_meters,
          COALESCE((
            SELECT SUM(COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
            FROM "${schema}".refund_items ri
            INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
            INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
            LEFT JOIN "${schema}".invoice_items it ON ri.invoice_item_id = it.id
            WHERE inv2.created_by = :staffId
              AND inv2.status = 'Partially Refunded'
              AND r2.status = 'Completed'
          ), 0) AS refunded_cost
        FROM "${schema}".refunds r
        INNER JOIN "${schema}".invoices inv ON r.invoice_id = inv.id
        WHERE inv.created_by = :staffId
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
        WHERE inv.created_by = :staffId
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
        WHERE inv.created_by = :staffId
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
        WHERE inv.created_by = :staffId
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
        WHERE inv.created_by = :staffId
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
        WHERE inv.created_by = :staffId
          AND inv.status IN ('Paid', 'Partially Refunded')
        ORDER BY inv.created_at DESC
        LIMIT 3
        `,
        queryOpts,
      ),
    ]);

    const totalInvoices = Number(summaryRow.total_invoices || 0);
    if (totalInvoices === 0) {
      return res.json({
        success: true,
        data: {
          analysis: {
            performance_level: "new_staff",
            insights: [],
            preferences: {},
            behavior: {},
          },
        },
      });
    }

    const grossSales = parseFloat(summaryRow.gross_sales || 0);
    const refundedAmount = parseFloat(refundRow.refunded_amount || 0);
    const totalSales = Math.max(0, grossSales - refundedAmount);

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

    const avgSaleValue = totalSales / totalInvoices;
    const avgDaysBetweenSales = parseFloat(summaryRow.avg_days_between_sales || 0);

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

    const uniqueCustomers = Number(summaryRow.unique_customers || 0);

    let performanceLevel = "new_staff";
    if (totalInvoices >= 50) {
      performanceLevel = "top_performer";
    } else if (totalInvoices >= 20) {
      performanceLevel = "good_performer";
    } else if (totalInvoices >= 10) {
      performanceLevel = "average_performer";
    } else if (totalInvoices >= 3) {
      performanceLevel = "developing_staff";
    }

    const insights = [];

    if (totalInvoices >= 20) {
      insights.push("high_volume_seller");
    }

    if (preferredFabric) {
      insights.push(`sells_mostly_${preferredFabric}`);
    }

    if (avgDaysBetweenSales > 0 && avgDaysBetweenSales < 7) {
      insights.push("very_active");
    }

    if (avgSaleValue > 200) {
      insights.push("high_value_sales");
    }

    if (totalSales > 0 && totalProfit / totalSales > 0.3) {
      insights.push("profitable_seller");
    }

    if (uniqueCustomers > totalInvoices * 0.5) {
      insights.push("good_customer_retention");
    }

    const uniqueRecentMonths = new Set(
      recentMonthRows.map((r) => Number(r.month_idx)),
    );
    if (uniqueRecentMonths.size === 3 && totalInvoices >= 10) {
      insights.push("consistent_performer");
    }

    res.json({
      success: true,
      data: {
        analysis: {
          performance_level: performanceLevel,
          insights: insights,
          preferences: {
            preferred_fabric_type: preferredFabric || null,
            preferred_pattern: preferredPattern || null,
            fabric_distribution: fabricCount,
            pattern_distribution: patternCount,
          },
          behavior: {
            total_sales: totalSales.toFixed(3),
            total_items: totalItems,
            total_meters: totalMeters.toFixed(3),
            total_profit: totalProfit.toFixed(3),
            avg_sale_value: avgSaleValue.toFixed(3),
            avg_days_between_sales: Math.round(avgDaysBetweenSales),
            best_selling_day:
              bestDayOfWeek !== null ? dayNames[bestDayOfWeek] || null : null,
            best_selling_month:
              bestMonth !== null ? monthNames[bestMonth] || null : null,
            total_invoices: totalInvoices,
            unique_customers: uniqueCustomers,
            last_sale: summaryRow.last_sale ? new Date(summaryRow.last_sale) : null,
            first_sale: summaryRow.first_sale ? new Date(summaryRow.first_sale) : null,
          },
        },
      },
    });
  } catch (error) {
    logger.error("Staff Analytics Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process analytics. Please try again." });
  }
};

export const updateStaff = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    let { full_name, username, password, role, branch_id, is_active } =
      req.body;

    const staff = await User.schema(schema).findByPk(id);
    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    if (req.user.role !== "store_owner") {
      if (role && role !== staff.role) {
        return res.status(403).json({ message: "Only Store Owner can change roles." });
      }
      if (staff.id !== req.user.id && (staff.role === "store_owner" || staff.role === "branch_manager")) {
        return res
          .status(403)
          .json({ message: "Cannot modify Admins or other Managers." });
      }
    }

    if (req.user.role === "branch_manager") {
      if (staff.branch_id !== req.user.branch_id) {
        return res
          .status(403)
          .json({ message: "Access Denied: Not in your branch." });
      }
      if (branch_id && parseInt(branch_id) !== req.user.branch_id) {
        return res
          .status(403)
          .json({ message: "Cannot move staff to another branch." });
      }
    }

    if (username) {
      username = username.toLowerCase();
      if (username !== staff.username) {
        const existingUser = await User.schema(schema).findOne({ where: { username: { [Op.iLike]: username } } });
        if (existingUser) {
          return res.status(400).json({ message: "Username already exists" });
        }
      }
    }

    staff.full_name = full_name || staff.full_name;
    staff.username = username || staff.username;
    staff.role = role || staff.role;
    staff.branch_id = branch_id || staff.branch_id;
    if (is_active !== undefined) {
      if (is_active === false && staff.is_active !== false) {
        staff.token_version = (staff.token_version || 0) + 1;
      }
      staff.is_active = is_active;
    }

    if (password) {
      staff.password = password;
      staff.token_version = (staff.token_version || 0) + 1;
    }

    await staff.save();
    await invalidateAuthUserCache(schema, staff.id);

    res.json({
      success: true,
      message: "Staff updated successfully",
      data: { id: staff.id, username: staff.username },
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const deleteStaff = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
      return res
        .status(400)
        .json({ message: "You cannot delete your own account." });
    }

    const staff = await User.schema(schema).findByPk(id);

    if (!staff) return res.status(404).json({ message: "Staff not found" });

    if (staff.role === "store_owner") {
      return res
        .status(403)
        .json({ message: "CRITICAL: Cannot delete the Store Owner account." });
    }

    if (
      req.user.role === "branch_manager" &&
      staff.branch_id !== req.user.branch_id
    ) {
      return res
        .status(403)
        .json({ message: "Access Denied: Not in your branch." });
    }

    staff.is_active = false;
    staff.token_version = (staff.token_version || 0) + 1;
    await staff.save();
    await invalidateAuthUserCache(schema, staff.id);

    res.json({
      success: true,
      message: "Staff account deactivated successfully.",
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};
