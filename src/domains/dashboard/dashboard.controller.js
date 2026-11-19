import { Op, Sequelize } from "sequelize";
import sequelize from "../../config/database.js";
import Invoice from "../sales/invoice.model.js";
import InvoiceItem from "../sales/invoice-item.model.js";
import InventoryItem from "../inventory/item.model.js";
import User from "../auth/user.model.js";
import Branch from "../store/branch.model.js";
import Customer from "../customers/customer.model.js";
import WhatsappConfig from "../platform/whatsapp.config.model.js";
import logger from "../../utils/logger.js";
import { LOW_STOCK_SQL, totalStockMeters } from "../../utils/lowStock.js";
import { cacheGet, cacheSet } from "../../config/redis.js";
import {
  startOfKuwaitDay,
  endOfKuwaitDay,
  daysAgoKuwaitStart,
} from "../../utils/kuwaitTime.js";

const DASHBOARD_CACHE_TTL_SECONDS = Number(process.env.DASHBOARD_CACHE_TTL_SECONDS) || 300;

export const getOwnerDashboard = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;

    const { startDate, endDate } = req.query;
    let dateFilterStart = null;
    let dateFilterEnd = null;

    if (startDate && endDate) {
      dateFilterStart = startOfKuwaitDay(startDate);
      dateFilterEnd = endOfKuwaitDay(endDate);
    }

    const cacheKey = `dashboard:owner:${req.tenant.slug}:${startDate || "today"}:${endDate || "today"}`;

    const cachedDashboard = await cacheGet(cacheKey);
    if (cachedDashboard) {
      logger.info("Owner dashboard served from cache", {
        component: "dashboard",
        tenant: req.tenant.slug,
        requestId: req.requestId,
      });
      return res.json({
        success: true,
        data: {
          ...cachedDashboard,
        },
      });
    }

    logger.info("Owner dashboard fetching from database", {
      component: "dashboard",
      tenant: req.tenant.slug,
      startDate: dateFilterStart?.toISOString(),
      endDate: dateFilterEnd?.toISOString(),
      requestId: req.requestId,
    });

    const todayStart = dateFilterStart || daysAgoKuwaitStart(7);
    const todayEnd = dateFilterEnd || endOfKuwaitDay(new Date());
    const weekStart = daysAgoKuwaitStart(7);
    const monthStart = daysAgoKuwaitStart(30);

    // Aggregations run inside PostgreSQL: loading every invoice row (and its
    // items) into Node was the main cost and memory spike of this endpoint.
    const [periodTotals = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(inv.total_amount), 0) AS total_sales,
        COALESCE(SUM(inv.total_meters), 0) AS total_meters,
        COUNT(*)::int AS invoice_count
      FROM "${schema}".invoices inv
      WHERE inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
      `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const [periodRefunds = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(r.total_amount), 0) AS refunded_amount,
        COALESCE((
          SELECT SUM(COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
          FROM "${schema}".refund_items ri
          INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
          INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
          WHERE inv2.created_at >= :dateStart
            AND inv2.created_at <= :dateEnd
            AND inv2.status = 'Partially Refunded'
            AND r2.status = 'Completed'
        ), 0) AS refunded_meters,
        COALESCE((
          SELECT SUM(COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
          FROM "${schema}".refund_items ri
          INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
          INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
          LEFT JOIN "${schema}".invoice_items it ON ri.invoice_item_id = it.id
          WHERE inv2.created_at >= :dateStart
            AND inv2.created_at <= :dateEnd
            AND inv2.status = 'Partially Refunded'
            AND r2.status = 'Completed'
        ), 0) AS refunded_cost
      FROM "${schema}".refunds r
      INNER JOIN "${schema}".invoices inv ON r.invoice_id = inv.id
      WHERE inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status = 'Partially Refunded'
        AND r.status = 'Completed'
      `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const totalSalesToday = Math.max(
      0,
      parseFloat(periodTotals.total_sales || 0) - parseFloat(periodRefunds.refunded_amount || 0),
    );
    const totalMetersToday = Math.max(
      0,
      parseFloat(periodTotals.total_meters || 0) - parseFloat(periodRefunds.refunded_meters || 0),
    );
    const invoiceCountToday = parseInt(periodTotals.invoice_count || 0, 10);

    const [periodCost = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(
          COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
        ), 0) AS total_cost
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
      `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );
    const totalCostToday = Math.max(
      0,
      parseFloat(periodCost.total_cost || 0) - parseFloat(periodRefunds.refunded_cost || 0),
    );

    const topFabricRows = await sequelize.query(
      `
      SELECT
        it.fabric_type AS name,
        SUM(COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS meters,
        SUM(it.total_price) AS revenue,
        SUM(it.total_price) - SUM(
          COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
        ) AS profit
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
      GROUP BY it.fabric_type
      ORDER BY revenue DESC
      LIMIT 5
      `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const round3 = (value) => Math.round(parseFloat(value || 0) * 1000) / 1000;
    const topFabrics = topFabricRows.map((fabric) => ({
      name: fabric.name || "Other",
      fabric_type: fabric.name || "Other",
      meters: round3(fabric.meters),
      revenue: round3(fabric.revenue),
      profit: round3(fabric.profit),
    }));

    const netProfitToday = totalSalesToday - totalCostToday;
    const avgSaleValue =
      invoiceCountToday > 0 ? totalSalesToday / invoiceCountToday : 0;

    const [monthTotals = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(inv.total_amount), 0) AS month_sales,
        COALESCE(SUM(inv.total_meters), 0) AS month_meters,
        COUNT(*)::int AS month_invoices
      FROM "${schema}".invoices inv
      WHERE inv.created_at >= :monthStart
        AND inv.status IN ('Paid', 'Partially Refunded')
      `,
      {
        replacements: { monthStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );
    const monthSales = parseFloat(monthTotals.month_sales || 0);
    const monthMeters = parseFloat(monthTotals.month_meters || 0);
    const monthInvoiceCount = parseInt(monthTotals.month_invoices || 0, 10);

    const [inventoryTotals = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(
          COALESCE(length_m, 0) * COALESCE(cost_per_meter, 0) * COALESCE(quantity, 1)
        ), 0) AS total_inventory_value
      FROM "${schema}".inventory_items
      WHERE status = 'In Stock'
      `,
      {
        replacements: {},
        type: sequelize.QueryTypes.SELECT,
      },
    );
    const totalInventoryValue = parseFloat(
      inventoryTotals.total_inventory_value || 0,
    );

    const activeBranches = await Branch.schema(schema).count();

    const whatsappConfig = await WhatsappConfig.findOne({
      where: { tenant_slug: req.tenant.slug },
    });

    const salesTrend7Days = await Invoice.schema(schema).findAll({
      where: {
        createdAt: { [Op.gte]: weekStart },
        status: { [Op.in]: ["Paid", "Partially Refunded"] },
      },
      attributes: [
        [Sequelize.fn("date", Sequelize.col("created_at")), "date"],
        [Sequelize.fn("sum", Sequelize.col("total_amount")), "revenue"],
      ],
      group: [Sequelize.fn("date", Sequelize.col("created_at"))],
      order: [[Sequelize.fn("date", Sequelize.col("created_at")), "ASC"]],
      raw: true,
    });

    const salesTrend30Days = await Invoice.schema(schema).findAll({
      where: {
        createdAt: { [Op.gte]: monthStart },
        status: { [Op.in]: ["Paid", "Partially Refunded"] },
      },
      attributes: [
        [Sequelize.fn("date", Sequelize.col("created_at")), "date"],
        [Sequelize.fn("sum", Sequelize.col("total_amount")), "revenue"],
      ],
      group: [Sequelize.fn("date", Sequelize.col("created_at"))],
      order: [[Sequelize.fn("date", Sequelize.col("created_at")), "ASC"]],
      raw: true,
    });

    const branchSales = await Invoice.schema(schema).findAll({
      where: {
        createdAt: { [Op.between]: [todayStart, todayEnd] },
        status: { [Op.in]: ["Paid", "Partially Refunded"] },
      },
      attributes: [
        "branch_id",
        [Sequelize.fn("sum", Sequelize.col("total_amount")), "total_sales"],
      ],
      include: [
        { model: Branch.schema(schema), as: "branch", attributes: ["name"] },
      ],
      group: ["branch_id", "branch.id", "branch.name"],
      raw: true,
      nest: true,
    });

    const categoryFabricSales = await sequelize.query(
      `
      SELECT
        CONCAT(it.fabric_type, ' · ', COALESCE(it.color, '')) AS name,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        SUM(
          COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
        ) AS cost,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
      GROUP BY it.fabric_type, it.color
      ORDER BY revenue DESC
    `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const categoryFabricWithProfit = categoryFabricSales.map((item) => ({
      name: item.name,
      fabric_type: item.fabric_type || null,
      revenue: parseFloat(item.revenue || 0),
      profit: parseFloat(item.revenue || 0) - parseFloat(item.cost || 0),
      quantity: parseInt(item.quantity || 0),
    }));

    const fabricSales = await sequelize.query(
      `
      SELECT
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
        AND it.fabric_type IS NOT NULL
      GROUP BY it.fabric_type
      ORDER BY it.fabric_type ASC
    `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const topItemsRevenue = await sequelize.query(
      `
      SELECT
        ii.id,
        ii.item_name AS name,
        ii.fabric_type,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        SUM(
          COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
        ) AS cost,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
      GROUP BY ii.id, ii.item_name, it.fabric_type, it.color, ii.fabric_type
      ORDER BY revenue DESC
      LIMIT 5
    `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const topItemsWithProfit = topItemsRevenue.map((item) => ({
      id: item.id,
      name: item.name,
      fabric_type: item.fabric_type || null,
      revenue: parseFloat(item.revenue || 0),
      profit: parseFloat(item.revenue || 0) - parseFloat(item.cost || 0),
      quantity: parseInt(item.quantity || 0),
    }));

    const topCustomers = await Invoice.schema(schema).findAll({
      where: {
        createdAt: { [Op.between]: [todayStart, todayEnd] },
        status: { [Op.in]: ["Paid", "Partially Refunded"] },
      },
      attributes: [
        "customer_id",
        [Sequelize.fn("sum", Sequelize.col("total_amount")), "total_value"],
      ],
      include: [
        {
          model: Customer.schema(schema),
          as: "customer",
          attributes: ["full_name"],
        },
      ],
      group: ["customer_id", "customer.id", "customer.full_name"],
      order: [[Sequelize.fn("sum", Sequelize.col("total_amount")), "DESC"]],
      limit: 5,
      raw: true,
      nest: true,
    });

    const lowStockItems = await InventoryItem.schema(schema).findAll({
      where: {
        status: "In Stock",
        [Op.and]: Sequelize.literal(LOW_STOCK_SQL),
        alert_dismissed_at: null,
      },
      attributes: [
        "id",
        "item_name",
        "pattern",
        "length_m",
        "quantity",
        "min_stock_level",
      ],
      limit: 20,
    });

    const dashboardData = {
      kpi: {
        total_sales: totalSalesToday.toFixed(3),
        net_profit: netProfitToday.toFixed(3),
        total_meters: totalMetersToday.toFixed(3),
        invoice_count: invoiceCountToday,
        avg_sale_value: avgSaleValue.toFixed(3),
        month_sales: monthSales.toFixed(3),
        month_invoices: monthInvoiceCount,
        month_meters: monthMeters.toFixed(3),
        total_inventory_value: totalInventoryValue.toFixed(3),
        active_branches: activeBranches,
        whatsapp_status: whatsappConfig?.session_status || "DISCONNECTED",
      },
      charts: {
        sales_trend_7d: salesTrend7Days.map((d) => ({
          date: d.date,
          revenue: parseFloat(d.revenue || 0),
        })),
        sales_trend_30d: salesTrend30Days.map((d) => ({
          date: d.date,
          revenue: parseFloat(d.revenue || 0),
        })),
        sales_by_branch: branchSales.map((b) => ({
          name: b.branch?.name || "Unknown",
          revenue: parseFloat(b.total_sales || 0),
        })),
        sales_by_category_fabric: categoryFabricWithProfit,
        sales_by_fabric: fabricSales.map((k) => ({
          fabric_type: k.fabric_type || null,
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        top_5_items_revenue: topItemsWithProfit,
        top_fabrics: topFabrics,
        top_5_customers: topCustomers.map((c) => ({
          name: c.customer?.full_name || "Unknown",
          value: parseFloat(c.total_value || 0),
        })),
      },
      alerts: {
        low_stock_items: lowStockItems.map((i) => ({
          id: i.id,
          name: i.item_name,
          pattern: i.pattern,
          quantity: i.quantity,
          stock_meters: totalStockMeters(i),
          min_stock_level: i.min_stock_level,
        })),
      },
      last_updated: new Date().toISOString(),
    };

    await cacheSet(cacheKey, dashboardData, DASHBOARD_CACHE_TTL_SECONDS);

    res.json({
      success: true,
      data: {
        ...dashboardData,
      },
    });
  } catch (error) {
    logger.error("Owner dashboard error", {
      component: "dashboard",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
      tenant: req.tenant?.slug,
    });
    if (process.env.NODE_ENV === "development") {
      console.error("Owner dashboard error details:", error);
    }
    res.status(500).json({
      success: false,
      message: "Failed to load dashboard data. Please try again.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

export const getManagerDashboard = async (req, res) => {
  try {
    const branchId = req.user.branch_id;
    const schema = req.tenant.db_schema;

    const { startDate, endDate } = req.query;
    let dateFilterStart = null;
    let dateFilterEnd = null;

    if (startDate && endDate) {
      dateFilterStart = startOfKuwaitDay(startDate);
      dateFilterEnd = endOfKuwaitDay(endDate);
    }

    const cacheKey = `dashboard:manager:${req.tenant.slug}:${branchId}:${startDate || "today"}:${endDate || "today"}`;

    const cachedManagerDashboard = await cacheGet(cacheKey);
    if (cachedManagerDashboard) {
      logger.info("Manager dashboard served from cache", {
        component: "dashboard",
        tenant: req.tenant.slug,
        branchId,
        requestId: req.requestId,
      });
      return res.json({
        success: true,
        data: {
          ...cachedManagerDashboard,
        },
      });
    }

    logger.info("Manager dashboard fetching from database", {
      component: "dashboard",
      tenant: req.tenant.slug,
      branchId,
      startDate: dateFilterStart?.toISOString(),
      endDate: dateFilterEnd?.toISOString(),
      requestId: req.requestId,
    });

    const todayStart = dateFilterStart || daysAgoKuwaitStart(7);
    const todayEnd = dateFilterEnd || endOfKuwaitDay(new Date());
    const weekStart = daysAgoKuwaitStart(7);
    const monthStart = daysAgoKuwaitStart(30);

    const [
      branchTotalsRows,
      lowStockItems,
      salesTrend7Days,
      salesTrend30Days,
      categoryFabricSales,
      fabricSales,
      staffPerformanceToday,
      staffPerformanceWeek,
      staffPerformanceMonth,
      topItemsRevenue,
      topCustomers,
    ] = await Promise.all([

      sequelize.query(
        `
        SELECT
          COALESCE(SUM(inv.total_amount), 0) AS total_sales,
          COALESCE(SUM(inv.total_meters), 0) AS total_meters,
          COUNT(*)::int AS invoice_count
        FROM "${schema}".invoices inv
        WHERE inv.branch_id = :branchId
          AND inv.created_at >= :dateStart
          AND inv.created_at <= :dateEnd
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { branchId, dateStart: todayStart, dateEnd: todayEnd },
          type: sequelize.QueryTypes.SELECT,
        },
      ),

      InventoryItem.schema(schema).findAll({
        where: {
          branch_id: branchId,
          status: "In Stock",
          [Op.and]: Sequelize.literal(LOW_STOCK_SQL),
          alert_dismissed_at: null,
        },
        attributes: [
          "id",
          "item_name",
          "pattern",
          "length_m",
          "quantity",
          "min_stock_level",
        ],
        limit: 20,
      }),

      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.gte]: weekStart },
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
        },
        attributes: [
          [Sequelize.fn("date", Sequelize.col("created_at")), "date"],
          [Sequelize.fn("sum", Sequelize.col("total_amount")), "revenue"],
        ],
        group: [Sequelize.fn("date", Sequelize.col("created_at"))],
        order: [[Sequelize.fn("date", Sequelize.col("created_at")), "ASC"]],
        raw: true,
      }),

      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.gte]: monthStart },
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
        },
        attributes: [
          [Sequelize.fn("date", Sequelize.col("created_at")), "date"],
          [Sequelize.fn("sum", Sequelize.col("total_amount")), "revenue"],
        ],
        group: [Sequelize.fn("date", Sequelize.col("created_at"))],
        order: [[Sequelize.fn("date", Sequelize.col("created_at")), "ASC"]],
        raw: true,
      }),

      sequelize.query(
        `
        SELECT
          CONCAT(it.fabric_type, ' · ', COALESCE(it.color, '')) AS name,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        WHERE inv.branch_id = :branchId AND inv.created_at >= :todayStart AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY it.fabric_type, it.color
        ORDER BY revenue DESC
      `,
        {
          replacements: { branchId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),

      sequelize.query(
        `
        SELECT
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.branch_id = :branchId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
          AND it.fabric_type IS NOT NULL
        GROUP BY it.fabric_type
        ORDER BY it.fabric_type ASC
      `,
        {
          replacements: { branchId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),

      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.gte]: todayStart },
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
        },
        attributes: [
          [Sequelize.col("Invoice.created_by"), "created_by"],
          [
            Sequelize.fn("sum", Sequelize.col("Invoice.total_amount")),
            "total_sales",
          ],
          [Sequelize.fn("count", Sequelize.col("Invoice.id")), "invoice_count"],
        ],
        include: [
          {
            model: User.schema(schema),
            as: "creator",
            attributes: ["full_name"],
          },
        ],
        group: [
          Sequelize.col("Invoice.created_by"),
          Sequelize.col("creator.id"),
          Sequelize.col("creator.full_name"),
        ],
        order: [
          [Sequelize.fn("sum", Sequelize.col("Invoice.total_amount")), "DESC"],
        ],
        raw: true,
        nest: true,
      }),

      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.gte]: weekStart },
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
        },
        attributes: [
          [Sequelize.col("Invoice.created_by"), "created_by"],
          [
            Sequelize.fn("sum", Sequelize.col("Invoice.total_amount")),
            "total_sales",
          ],
          [Sequelize.fn("count", Sequelize.col("Invoice.id")), "invoice_count"],
        ],
        include: [
          {
            model: User.schema(schema),
            as: "creator",
            attributes: ["full_name"],
          },
        ],
        group: [
          Sequelize.col("Invoice.created_by"),
          Sequelize.col("creator.id"),
          Sequelize.col("creator.full_name"),
        ],
        order: [
          [Sequelize.fn("sum", Sequelize.col("Invoice.total_amount")), "DESC"],
        ],
        raw: true,
        nest: true,
      }),

      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.gte]: monthStart },
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
        },
        attributes: [
          [Sequelize.col("Invoice.created_by"), "created_by"],
          [
            Sequelize.fn("sum", Sequelize.col("Invoice.total_amount")),
            "total_sales",
          ],
          [Sequelize.fn("count", Sequelize.col("Invoice.id")), "invoice_count"],
        ],
        include: [
          {
            model: User.schema(schema),
            as: "creator",
            attributes: ["full_name"],
          },
        ],
        group: [
          Sequelize.col("Invoice.created_by"),
          Sequelize.col("creator.id"),
          Sequelize.col("creator.full_name"),
        ],
        order: [
          [Sequelize.fn("sum", Sequelize.col("Invoice.total_amount")), "DESC"],
        ],
        raw: true,
        nest: true,
      }),

      sequelize.query(
        `
        SELECT
          ii.id,
          ii.item_name AS name,
          ii.fabric_type,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.branch_id = :branchId AND inv.created_at >= :todayStart AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY ii.id, ii.item_name, it.fabric_type, it.color, ii.fabric_type
        ORDER BY revenue DESC
        LIMIT 5
      `,
        {
          replacements: { branchId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),

      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.gte]: todayStart },
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
        },
        attributes: [
          "customer_id",
          [Sequelize.fn("sum", Sequelize.col("total_amount")), "total_value"],
        ],
        include: [
          {
            model: Customer.schema(schema),
            as: "customer",
            attributes: ["full_name"],
          },
        ],
        group: ["customer_id", "customer.id", "customer.full_name"],
        order: [[Sequelize.fn("sum", Sequelize.col("total_amount")), "DESC"]],
        limit: 5,
        raw: true,
        nest: true,
      }),
    ]);

    const [branchTotals = {}] = branchTotalsRows;

    const [branchRefunds = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(r.total_amount), 0) AS refunded_amount,
        COALESCE((
          SELECT SUM(COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
          FROM "${schema}".refund_items ri
          INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
          INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
          WHERE inv2.branch_id = :branchId
            AND inv2.created_at >= :dateStart
            AND inv2.created_at <= :dateEnd
            AND inv2.status = 'Partially Refunded'
            AND r2.status = 'Completed'
        ), 0) AS refunded_meters,
        COALESCE((
          SELECT SUM(COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
          FROM "${schema}".refund_items ri
          INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
          INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
          LEFT JOIN "${schema}".invoice_items it ON ri.invoice_item_id = it.id
          WHERE inv2.branch_id = :branchId
            AND inv2.created_at >= :dateStart
            AND inv2.created_at <= :dateEnd
            AND inv2.status = 'Partially Refunded'
            AND r2.status = 'Completed'
        ), 0) AS refunded_cost
      FROM "${schema}".refunds r
      INNER JOIN "${schema}".invoices inv ON r.invoice_id = inv.id
      WHERE inv.branch_id = :branchId
        AND inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status = 'Partially Refunded'
        AND r.status = 'Completed'
      `,
      {
        replacements: { branchId, dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const branchSalesToday = Math.max(
      0,
      parseFloat(branchTotals.total_sales || 0) - parseFloat(branchRefunds.refunded_amount || 0),
    );
    const totalMetersToday = Math.max(
      0,
      parseFloat(branchTotals.total_meters || 0) - parseFloat(branchRefunds.refunded_meters || 0),
    );
    const branchInvoiceCount = parseInt(branchTotals.invoice_count || 0, 10);

    const [branchCost = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(
          COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
        ), 0) AS total_cost
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.branch_id = :branchId
        AND inv.created_at >= :dateStart
        AND inv.created_at <= :dateEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
      `,
      {
        replacements: { branchId, dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );
    const totalCostToday = Math.max(
      0,
      parseFloat(branchCost.total_cost || 0) - parseFloat(branchRefunds.refunded_cost || 0),
    );

    const netProfitToday = branchSalesToday - totalCostToday;
    const avgSaleValue =
      branchInvoiceCount > 0 ? branchSalesToday / branchInvoiceCount : 0;

    const dashboardData = {
      kpi: {
        branch_sales: branchSalesToday.toFixed(3),
        net_profit: netProfitToday.toFixed(3),
        total_meters: totalMetersToday.toFixed(3),
        invoice_count: branchInvoiceCount,
        avg_sale_value: avgSaleValue.toFixed(3),
        low_stock_count: lowStockItems.length,
      },
      charts: {
        salesTrend7d: salesTrend7Days.map((d) => ({
          date: d.date,
          revenue: parseFloat(d.revenue || 0),
        })),
        salesTrend30d: salesTrend30Days.map((d) => ({
          date: d.date,
          revenue: parseFloat(d.revenue || 0),
        })),
        salesByCategoryFabric: categoryFabricSales.map((c) => ({
          name: c.name,
          revenue: parseFloat(c.revenue || 0),
          quantity: parseInt(c.quantity || 0),
        })),
        salesByFabric: fabricSales.map((k) => ({
          fabric_type: k.fabric_type || "-",
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        staffPerformanceToday: staffPerformanceToday.map((s) => ({
          name: s.creator?.full_name || "Unknown",
          sales: parseFloat(s.total_sales || 0),
          invoices: parseInt(s.invoice_count || 0),
        })),
        staffPerformanceWeek: staffPerformanceWeek.map((s) => ({
          name: s.creator?.full_name || "Unknown",
          sales: parseFloat(s.total_sales || 0),
          invoices: parseInt(s.invoice_count || 0),
        })),
        staffPerformanceMonth: staffPerformanceMonth.map((s) => ({
          name: s.creator?.full_name || "Unknown",
          sales: parseFloat(s.total_sales || 0),
          invoices: parseInt(s.invoice_count || 0),
        })),
        top5ItemsRevenue: topItemsRevenue.map((i) => ({
          id: i.id,
          name: i.name,
          fabric_type: i.fabric_type || null,
          revenue: parseFloat(i.revenue || 0),
          quantity: parseInt(i.quantity || 0),
        })),
        top5Customers: topCustomers.map((c) => ({
          name: c.customer?.full_name || "Unknown",
          value: parseFloat(c.total_value || 0),
        })),
      },
      alerts: {
        low_stock_items: lowStockItems.map((i) => ({
          id: i.id,
          name: i.item_name,
          pattern: i.pattern,
          quantity: i.quantity,
          stock_meters: totalStockMeters(i),
          min_stock_level: i.min_stock_level,
        })),
      },
      last_updated: new Date().toISOString(),
    };

    await cacheSet(cacheKey, dashboardData, DASHBOARD_CACHE_TTL_SECONDS);

    res.json({
      success: true,
      data: {
        ...dashboardData,
      },
    });
  } catch (error) {
    logger.error("Manager dashboard error", {
      component: "dashboard",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
      tenant: req.tenant?.slug,
      branchId: req.user?.branch_id,
    });
    console.error("Manager dashboard error details:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load dashboard data. Please try again.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};

export const getSalesmanDashboard = async (req, res) => {
  try {
    const userId = req.user.id;
    const schema = req.tenant.db_schema;
    const { startDate, endDate } = req.query;
    const cacheKey = `dashboard:salesman:${req.tenant.slug}:${userId}:${startDate || "today"}:${endDate || "today"}`;

    const cachedData = await cacheGet(cacheKey);
    if (cachedData) {
      logger.info("Salesman dashboard served from cache", {
        component: "dashboard",
        tenant: req.tenant.slug,
        userId,
        requestId: req.requestId,
      });
      return res.json({
        success: true,
        data: {
          ...cachedData,
        },
      });
    }

    logger.info("Salesman dashboard fetching from database", {
      component: "dashboard",
      tenant: req.tenant.slug,
      userId,
      requestId: req.requestId,
    });

    const todayStart = startDate ? startOfKuwaitDay(startDate) : startOfKuwaitDay(new Date());
    const todayEnd = endDate ? endOfKuwaitDay(endDate) : endOfKuwaitDay(new Date());
    const weekStart = daysAgoKuwaitStart(7);

    const [myTotals = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(inv.total_amount), 0) AS my_sales_today,
        COUNT(*)::int AS invoice_count
      FROM "${schema}".invoices inv
      WHERE inv.created_by = :userId
        AND inv.created_at >= :todayStart
        AND inv.created_at <= :todayEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
      `,
      {
        replacements: { userId, todayStart, todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const [itemsTotals = {}] = await sequelize.query(
      `
      SELECT COUNT(*)::int AS items_sold
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.created_by = :userId
        AND inv.created_at >= :todayStart
        AND inv.created_at <= :todayEnd
        AND inv.status IN ('Paid', 'Partially Refunded')
      `,
      {
        replacements: { userId, todayStart, todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const mySalesToday = parseFloat(myTotals.my_sales_today || 0);
    const myInvoiceCount = parseInt(myTotals.invoice_count || 0, 10);
    const itemsSoldCount = parseInt(itemsTotals.items_sold || 0, 10);
    const avgSaleValue =
      myInvoiceCount > 0 ? mySalesToday / myInvoiceCount : 0;

    const salesTrend7Days = await Invoice.schema(schema).findAll({
      where: {
        created_by: userId,
        createdAt: { [Op.gte]: weekStart },
        status: { [Op.in]: ["Paid", "Partially Refunded"] },
      },
      attributes: [
        [Sequelize.fn("date", Sequelize.col("created_at")), "date"],
        [Sequelize.fn("sum", Sequelize.col("total_amount")), "revenue"],
      ],
      group: [Sequelize.fn("date", Sequelize.col("created_at"))],
      order: [[Sequelize.fn("date", Sequelize.col("created_at")), "ASC"]],
      raw: true,
    });

    const categoryFabricSales = await sequelize.query(
      `
      SELECT
        CONCAT(it.fabric_type, ' · ', COALESCE(it.color, '')) AS name,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status IN ('Paid', 'Partially Refunded')
      GROUP BY it.fabric_type, it.color
      ORDER BY revenue DESC
    `,
      {
        replacements: { userId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const fabricSales = await sequelize.query(
      `
      SELECT
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_by = :userId
        AND inv.created_at >= :todayStart
        AND inv.status IN ('Paid', 'Partially Refunded')
        AND it.fabric_type IS NOT NULL
      GROUP BY it.fabric_type
      ORDER BY it.fabric_type ASC
    `,
      {
        replacements: { userId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const topItems = await sequelize.query(
      `
      SELECT
        ii.id,
        ii.item_name AS name,
        ii.fabric_type,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status IN ('Paid', 'Partially Refunded')
      GROUP BY ii.id, ii.item_name, it.fabric_type, it.color, ii.fabric_type
      ORDER BY revenue DESC
      LIMIT 5
    `,
      {
        replacements: { userId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const dashboardData = {
      kpi: {
        my_sales_today: mySalesToday.toFixed(3),
        items_sold_count: itemsSoldCount,
        avg_sale_value: avgSaleValue.toFixed(3),
      },
      charts: {
        sales_trend_7d: salesTrend7Days.map((d) => ({
          date: d.date,
          revenue: parseFloat(d.revenue || 0),
        })),
        sales_by_category_fabric: categoryFabricSales.map((c) => ({
          name: c.name,
          revenue: parseFloat(c.revenue || 0),
          quantity: parseInt(c.quantity || 0),
        })),
        sales_by_fabric: fabricSales.map((k) => ({
          fabric_type: k.fabric_type || null,
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        top_5_items: topItems.map((i) => ({
          id: i.id,
          name: i.name,
          fabric_type: i.fabric_type || null,
          revenue: parseFloat(i.revenue || 0),
          quantity: parseInt(i.quantity || 0),
        })),
      },
      last_updated: new Date().toISOString(),
    };

    await cacheSet(cacheKey, dashboardData, DASHBOARD_CACHE_TTL_SECONDS);

    res.json({
      success: true,
      data: {
        ...dashboardData,
      },
    });
  } catch (error) {
    logger.error("Salesman dashboard error", {
      component: "dashboard",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
      tenant: req.tenant?.slug,
      userId: req.user?.id,
    });
    console.error("Salesman dashboard error details:", error);
    res.status(500).json({
      success: false,
      message: "Failed to load dashboard data. Please try again.",
      error: process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
};
export const getDashboardAnalytics = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      branchIds,
      compare = "false",
      compareType = "previous_period",
    } = req.query;
    const schema = req.tenant.db_schema;

    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "startDate and endDate are required",
      });
    }

    const start = new Date(startDate);
    const end = new Date(endDate);
    if (isNaN(start.getTime()) || isNaN(end.getTime())) {
      return res.status(400).json({
        message:
          "Invalid date format. Use ISO 8601 format (YYYY-MM-DDTHH:mm:ss.sssZ)",
      });
    }

    if (start > end) {
      return res.status(400).json({
        message: "startDate must be before endDate",
      });
    }

    let branchFilter = {};
    if (req.user.role === "branch_manager" || req.user.role === "sales_man") {

      branchFilter.branch_id = req.user.branch_id;
    } else if (branchIds) {

      const branchArray = Array.isArray(branchIds)
        ? branchIds
        : branchIds.split(",").map((id) => parseInt(id));
      if (branchArray.length > 0) {
        branchFilter.branch_id = { [Op.in]: branchArray };
      }
    }

    const fetchPeriodData = async (start, end) => {
      try {
        const startDateObj = start instanceof Date ? start : new Date(start);
        const endDateObj = end instanceof Date ? end : new Date(end);

        if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
          throw new Error("Invalid date range provided");
        }

        const baseReplacements = {
          start: startDateObj,
          end: endDateObj,
        };
        let branchSql = "";
        if (branchFilter.branch_id) {
          if (branchFilter.branch_id[Op.in]) {
            branchSql = " AND inv.branch_id IN (:branchIds)";
            baseReplacements.branchIds = branchFilter.branch_id[Op.in];
          } else if (typeof branchFilter.branch_id === "number") {
            branchSql = " AND inv.branch_id = :branchId";
            baseReplacements.branchId = branchFilter.branch_id;
          }
        }

        const daysDiff = Math.ceil(
          (endDateObj - startDateObj) / (1000 * 60 * 60 * 24),
        );
        const truncUnit = daysDiff <= 30 ? "day" : daysDiff <= 90 ? "week" : "month";

        const [
          [kpiRow = {}],
          [refundTotals = {}],
          salesTrendRows,
          categoryRows,
          fabricRows,
          branchRows,
        ] = await Promise.all([
          sequelize.query(
            `
            SELECT
              COALESCE(SUM(inv.total_amount), 0) AS revenue,
              COALESCE(SUM(inv.total_meters), 0) AS meters_sold,
              COUNT(inv.id)::int AS transactions,
              COALESCE((
                SELECT SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1))
                FROM "${schema}".invoice_items it
                INNER JOIN "${schema}".invoices inv2 ON it.invoice_id = inv2.id
                LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
                WHERE inv2.created_at BETWEEN :start AND :end
                  AND inv2.status IN ('Paid', 'Partially Refunded')
                  ${branchSql.replace(/inv\./g, "inv2.")}
              ), 0) AS total_cost,
              COALESCE((
                SELECT SUM(COALESCE(it.quantity, 1))::int
                FROM "${schema}".invoice_items it
                INNER JOIN "${schema}".invoices inv2 ON it.invoice_id = inv2.id
                WHERE inv2.created_at BETWEEN :start AND :end
                  AND inv2.status IN ('Paid', 'Partially Refunded')
                  ${branchSql.replace(/inv\./g, "inv2.")}
              ), 0) AS total_quantity
            FROM "${schema}".invoices inv
            WHERE inv.created_at BETWEEN :start AND :end
              AND inv.status IN ('Paid', 'Partially Refunded')
              ${branchSql}
            `,
            { replacements: baseReplacements, type: sequelize.QueryTypes.SELECT },
          ),
          sequelize.query(
            `
            SELECT
              COALESCE(SUM(r.total_amount), 0) AS refunded_amount,
              COALESCE((
                SELECT SUM(COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
                FROM "${schema}".refund_items ri
                INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
                INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
                WHERE inv2.created_at BETWEEN :start AND :end
                  AND inv2.status = 'Partially Refunded'
                  AND r2.status = 'Completed'
                  ${branchSql.replace(/inv\./g, "inv2.")}
              ), 0) AS refunded_meters,
              COALESCE((
                SELECT SUM(COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
                FROM "${schema}".refund_items ri
                INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
                INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
                LEFT JOIN "${schema}".invoice_items it ON ri.invoice_item_id = it.id
                WHERE inv2.created_at BETWEEN :start AND :end
                  AND inv2.status = 'Partially Refunded'
                  AND r2.status = 'Completed'
                  ${branchSql.replace(/inv\./g, "inv2.")}
              ), 0) AS refunded_cost
            FROM "${schema}".refunds r
            INNER JOIN "${schema}".invoices inv ON r.invoice_id = inv.id
            WHERE inv.created_at BETWEEN :start AND :end
              AND inv.status = 'Partially Refunded'
              AND r.status = 'Completed'
              ${branchSql}
            `,
            { replacements: baseReplacements, type: sequelize.QueryTypes.SELECT },
          ),
          sequelize.query(
            `
            SELECT
              DATE_TRUNC('${truncUnit}', inv.created_at) AS date,
              COALESCE(SUM(inv.total_amount), 0) AS revenue,
              COALESCE(SUM(inv.total_meters), 0) AS meters,
              COUNT(inv.id)::int AS quantity,
              COALESCE(SUM(item_costs.cost), 0) AS cost
            FROM "${schema}".invoices inv
            LEFT JOIN (
              SELECT
                it.invoice_id,
                SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS cost
              FROM "${schema}".invoice_items it
              LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
              GROUP BY it.invoice_id
            ) item_costs ON item_costs.invoice_id = inv.id
            WHERE inv.created_at BETWEEN :start AND :end
              AND inv.status IN ('Paid', 'Partially Refunded')
              ${branchSql}
            GROUP BY DATE_TRUNC('${truncUnit}', inv.created_at)
            ORDER BY DATE_TRUNC('${truncUnit}', inv.created_at) ASC
            `,
            { replacements: baseReplacements, type: sequelize.QueryTypes.SELECT },
          ),
          sequelize.query(
            `
            SELECT
              COALESCE(NULLIF(ii.pattern, ''), COALESCE(it.fabric_type, ii.fabric_type, 'Other')) AS name,
              COALESCE(SUM(it.total_price), 0) AS revenue,
              COALESCE(SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) AS cost,
              COALESCE(SUM(COALESCE(it.quantity, 1)), 0)::int AS quantity
            FROM "${schema}".invoice_items it
            INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
            LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
            WHERE inv.created_at BETWEEN :start AND :end
              AND inv.status IN ('Paid', 'Partially Refunded')
              ${branchSql}
            GROUP BY COALESCE(NULLIF(ii.pattern, ''), COALESCE(it.fabric_type, ii.fabric_type, 'Other'))
            ORDER BY revenue DESC
            `,
            { replacements: baseReplacements, type: sequelize.QueryTypes.SELECT },
          ),
          sequelize.query(
            `
            SELECT
              COALESCE(it.fabric_type, ii.fabric_type, 'Other') AS fabric_type,
              COALESCE(SUM(it.total_price), 0) AS revenue,
              COALESCE(SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) AS cost,
              COALESCE(SUM(COALESCE(it.quantity, 1)), 0)::int AS quantity,
              COALESCE(SUM(COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) AS meters
            FROM "${schema}".invoice_items it
            INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
            LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
            WHERE inv.created_at BETWEEN :start AND :end
              AND inv.status IN ('Paid', 'Partially Refunded')
              ${branchSql}
            GROUP BY COALESCE(it.fabric_type, ii.fabric_type, 'Other')
            ORDER BY revenue DESC
            `,
            { replacements: baseReplacements, type: sequelize.QueryTypes.SELECT },
          ),
          sequelize.query(
            `
            SELECT
              inv.branch_id,
              COALESCE(b.name, 'Unknown') AS name,
              COALESCE(SUM(inv.total_amount), 0) AS revenue,
              COUNT(inv.id)::int AS quantity,
              COALESCE(SUM(item_costs.cost), 0) AS cost
            FROM "${schema}".invoices inv
            LEFT JOIN "${schema}".branches b ON b.id = inv.branch_id
            LEFT JOIN (
              SELECT
                it.invoice_id,
                SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS cost
              FROM "${schema}".invoice_items it
              LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
              GROUP BY it.invoice_id
            ) item_costs ON item_costs.invoice_id = inv.id
            WHERE inv.created_at BETWEEN :start AND :end
              AND inv.status IN ('Paid', 'Partially Refunded')
              ${branchSql}
            GROUP BY inv.branch_id, b.name
            ORDER BY revenue DESC
            `,
            { replacements: baseReplacements, type: sequelize.QueryTypes.SELECT },
          ),
        ]);

        const refundedAmount = parseFloat(refundTotals.refunded_amount || 0);
        const refundedMeters = parseFloat(refundTotals.refunded_meters || 0);
        const refundedCost = parseFloat(refundTotals.refunded_cost || 0);

        const totalRevenue = Math.max(0, parseFloat(kpiRow.revenue || 0) - refundedAmount);
        const totalCost = Math.max(0, parseFloat(kpiRow.total_cost || 0) - refundedCost);
        const grossProfit = totalRevenue - totalCost;
        const totalMetersSold = Math.max(0, parseFloat(kpiRow.meters_sold || 0) - refundedMeters);
        const totalTransactions = parseInt(kpiRow.transactions || 0, 10);
        const totalQuantity = parseInt(kpiRow.total_quantity || 0, 10);

        const salesTrendWithProfit = salesTrendRows.map((row) => {
          const rev = parseFloat(row.revenue || 0);
          const cost = parseFloat(row.cost || 0);
          return {
            date: row.date instanceof Date ? row.date.toISOString().split("T")[0] : row.date,
            revenue: rev,
            profit: rev - cost,
            meters: parseFloat(row.meters || 0),
            quantity: parseInt(row.quantity || 0, 10),
          };
        });

        const categoryDistribution = categoryRows.map((row) => {
          const rev = parseFloat(row.revenue || 0);
          const cost = parseFloat(row.cost || 0);
          return {
            name: row.name,
            revenue: rev,
            profit: rev - cost,
            quantity: parseInt(row.quantity || 0, 10),
          };
        });

        const fabricDistribution = fabricRows.map((row) => {
          const rev = parseFloat(row.revenue || 0);
          const cost = parseFloat(row.cost || 0);
          return {
            fabric_type: row.fabric_type,
            revenue: rev,
            profit: rev - cost,
            quantity: parseInt(row.quantity || 0, 10),
            meters: parseFloat(row.meters || 0),
          };
        });

        const branchPerformance = branchRows.map((row) => {
          const rev = parseFloat(row.revenue || 0);
          const cost = parseFloat(row.cost || 0);
          return {
            name: row.name || "Unknown",
            revenue: rev,
            profit: rev - cost,
            quantity: parseInt(row.quantity || 0, 10),
          };
        });

        return {
          kpi: {
            revenue: totalRevenue,
            profit: grossProfit,
            meters_sold: totalMetersSold,
            transactions: totalTransactions,
            quantity: totalQuantity,
          },
          charts: {
            sales_trend: salesTrendWithProfit,
            category_distribution: categoryDistribution,
            pattern_distribution: categoryDistribution,
            fabric_distribution: fabricDistribution,
            branch_performance: branchPerformance,
          },
        };
      } catch (innerError) {
        logger.error("Error in fetchPeriodData", {
          component: "dashboard",
          error: innerError?.message,
          stack: innerError?.stack,
          start: start instanceof Date ? start : new Date(start),
          end: end instanceof Date ? end : new Date(end),
        });
        throw innerError;
      }
    };

    const effectiveBranchKey =
      req.user.role !== "store_owner"
        ? `b_${req.user.branch_id}`
        : branchIds || "all";
    const cacheKey = `analytics:${req.tenant.slug}:${startDate}:${endDate}:${effectiveBranchKey}:${compare}:${compareType}`;
    let dataSource = "live";
    let lastUpdated = new Date().toISOString();
    let nextUpdate = null;
    let currentPeriod = null;

    logger.info("Analytics request", {
      component: "dashboard",
      startDate,
      endDate,
      branchIds: branchIds || "all",
      cacheKey,
      tenant: req.tenant.slug,
      daysDiff: Math.ceil(
        (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24),
      ),
    });

    const cachedData = await cacheGet(cacheKey);
    if (cachedData) {
      if (cachedData && cachedData.current) {

        const cachedStartDate =
          cachedData.current?.charts?.sales_trend?.[0]?.date;
        const cachedEndDate =
          cachedData.current?.charts?.sales_trend?.[
            cachedData.current?.charts?.sales_trend?.length - 1
          ]?.date;

        logger.info("Cache hit", {
          component: "dashboard",
          cacheKey,
          cachedStartDate,
          cachedEndDate,
          requestedStartDate: startDate,
          requestedEndDate: endDate,
        });

        dataSource = "cache";
        currentPeriod = cachedData.current;
        lastUpdated = cachedData.last_updated || lastUpdated;

        const nextUpdateDate = new Date(lastUpdated);
        nextUpdateDate.setHours(nextUpdateDate.getHours() + 1);
        nextUpdate = nextUpdateDate.toISOString();
      } else {

        logger.info("Cache miss, fetching from database", {
          component: "dashboard",
          cacheKey,
        });
        currentPeriod = await fetchPeriodData(start, end);

        const nextUpdateDate = new Date();
        nextUpdateDate.setHours(nextUpdateDate.getHours() + 1);
        nextUpdate = nextUpdateDate.toISOString();
      }
    } else {

      logger.debug("Cache miss, fetching from database", {
        component: "dashboard",
      });
      currentPeriod = await fetchPeriodData(start, end);
    }

    if (!currentPeriod) {
      logger.warn("CurrentPeriod is null, fetching again", {
        component: "dashboard",
      });
      currentPeriod = await fetchPeriodData(start, end);
    }

    let result = {
      current: currentPeriod,
      data_source: dataSource,
      last_updated: lastUpdated,
      next_update: nextUpdate,
    };

    const shouldCompare = compare === "true" || compare === true;

    if (shouldCompare) {
      const currStart = new Date(startDate);
      const currEnd = new Date(endDate);

      let prevStart, prevEnd;

      switch (compareType) {
        case "previous_week": {

          prevEnd = new Date(currEnd);
          prevEnd.setDate(prevEnd.getDate() - 7);
          prevStart = new Date(currStart);
          prevStart.setDate(prevStart.getDate() - 7);
          break;
        }
        case "previous_month": {

          prevEnd = new Date(currEnd);
          prevEnd.setMonth(prevEnd.getMonth() - 1);
          prevStart = new Date(currStart);
          prevStart.setMonth(prevStart.getMonth() - 1);
          break;
        }
        case "same_month_last_year": {

          prevEnd = new Date(currEnd);
          prevEnd.setFullYear(prevEnd.getFullYear() - 1);
          prevStart = new Date(currStart);
          prevStart.setFullYear(prevStart.getFullYear() - 1);
          break;
        }
        case "previous_quarter": {

          prevEnd = new Date(currEnd);
          prevEnd.setMonth(prevEnd.getMonth() - 3);
          prevStart = new Date(currStart);
          prevStart.setMonth(prevStart.getMonth() - 3);
          break;
        }
        case "previous_year": {

          prevEnd = new Date(currEnd);
          prevEnd.setFullYear(prevEnd.getFullYear() - 1);
          prevStart = new Date(currStart);
          prevStart.setFullYear(prevStart.getFullYear() - 1);
          break;
        }
        case "previous_period":
        default: {

          const diff = currEnd.getTime() - currStart.getTime();
          prevEnd = new Date(currStart.getTime() - 1);
          prevStart = new Date(currStart.getTime() - diff);
          break;
        }
      }

      const previousPeriod = await fetchPeriodData(
        prevStart.toISOString(),
        prevEnd.toISOString(),
      );

      const calculateChange = (curr, prev) => {
        if (!prev || prev === 0) return curr > 0 ? 100 : 0;
        return ((curr - prev) / prev) * 100;
      };

      result.comparison = previousPeriod;
      result.changes = {
        revenue: calculateChange(
          currentPeriod.kpi.revenue,
          previousPeriod.kpi.revenue,
        ),
        profit: calculateChange(
          currentPeriod.kpi.profit,
          previousPeriod.kpi.profit,
        ),
        meters_sold: calculateChange(
          currentPeriod.kpi.meters_sold,
          previousPeriod.kpi.meters_sold,
        ),
        transactions: calculateChange(
          currentPeriod.kpi.transactions,
          previousPeriod.kpi.transactions,
        ),
      };
    }

    if (dataSource === "live") {
      await cacheSet(
        cacheKey,
        {
          ...result,
          last_updated: lastUpdated,
        },
        3600,
      );
    }

    res.json({ success: true, data: result });
  } catch (error) {
    logger.error("Analytics error", {
      component: "dashboard",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
    });
    res
      .status(500)
      .json({ message: "Failed to load analytics data. Please try again." });
  }
};

export const getTopItems = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      branchIds,
      metric = "revenue",
      limit = 10,
    } = req.query;
    const schema = req.tenant.db_schema;

    const parsedLimit = Math.min(Math.max(1, parseInt(limit, 10) || 10), 100);
    const replacements = {
      startDate: startDate ? new Date(startDate) : new Date(0),
      endDate: endDate ? new Date(endDate) : new Date(),
      limit: parsedLimit,
    };

    let branchSql = "";
    if (req.user.role !== "store_owner") {
      branchSql = "AND inv.branch_id = :branchId";
      replacements.branchId = req.user.branch_id;
    } else if (branchIds) {
      const branchArray = String(branchIds)
        .split(",")
        .map((id) => parseInt(id.trim(), 10))
        .filter((id) => Number.isFinite(id) && id > 0);
      if (branchArray.length > 0) {
        branchSql = "AND inv.branch_id IN (:branchIds)";
        replacements.branchIds = branchArray;
      }
    }

    const orderColumn =
      metric === "profit"
        ? "profit"
        : metric === "quantity"
          ? "quantity"
          : metric === "meters"
            ? "meters"
            : "revenue";

    const rows = await sequelize.query(
      `
      SELECT
        ii.id,
        ii.item_name AS name,
        ii.pattern,
        COALESCE(ii.fabric_type, it.fabric_type) AS fabric_type,
        COALESCE(SUM(it.total_price), 0) AS revenue,
        COALESCE(SUM(it.total_price), 0) - COALESCE(SUM(
          COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
        ), 0) AS profit,
        COALESCE(SUM(COALESCE(it.quantity, 1)), 0)::int AS quantity,
        COALESCE(SUM(COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) AS meters
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_at BETWEEN :startDate AND :endDate
        AND inv.status IN ('Paid', 'Partially Refunded')
        ${branchSql}
      GROUP BY ii.id, ii.item_name, ii.pattern, COALESCE(ii.fabric_type, it.fabric_type)
      ORDER BY ${orderColumn} DESC
      LIMIT :limit
      `,
      {
        replacements,
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const data = rows.map((item) => ({
      id: item.id,
      name: item.name,
      pattern: item.pattern || null,
      fabric_type: item.fabric_type || null,
      revenue: parseFloat(item.revenue) || 0,
      profit: parseFloat(item.profit) || 0,
      quantity: parseInt(item.quantity, 10) || 0,
      meters: parseFloat(item.meters) || 0,
    }));

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.error("Top Items Error", {
      component: "dashboard",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to fetch top items. Please try again." });
  }
};
