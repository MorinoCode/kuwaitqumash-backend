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

const DASHBOARD_CACHE_TTL_SECONDS = Number(process.env.DASHBOARD_CACHE_TTL_SECONDS) || 300;

export const getOwnerDashboard = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;

    const { startDate, endDate } = req.query;
    let dateFilterStart = null;
    let dateFilterEnd = null;

    if (startDate && endDate) {
      dateFilterStart = new Date(startDate);
      dateFilterEnd = new Date(endDate);

      dateFilterStart.setHours(0, 0, 0, 0);
      dateFilterEnd.setHours(23, 59, 59, 999);
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

    const todayStart =
      dateFilterStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (!dateFilterStart) {
      todayStart.setHours(0, 0, 0, 0);
    }
    const todayEnd = dateFilterEnd || new Date();
    if (!dateFilterEnd) {
      todayEnd.setHours(23, 59, 59, 999);
    }

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);

    const monthStart = new Date();
    monthStart.setDate(monthStart.getDate() - 30);
    monthStart.setHours(0, 0, 0, 0);

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
        AND inv.status = 'Paid'
      `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const totalSalesToday = parseFloat(periodTotals.total_sales || 0);
    const totalMetersToday = parseFloat(periodTotals.total_meters || 0);
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
        AND inv.status = 'Paid'
      `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );
    const totalCostToday = parseFloat(periodCost.total_cost || 0);

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
        AND inv.status = 'Paid'
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
        AND inv.status = 'Paid'
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
        status: "Paid",
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
        status: "Paid",
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
        status: "Paid",
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
        AND inv.status = 'Paid'
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
        AND inv.status = 'Paid'
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
        AND inv.status = 'Paid'
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
        status: "Paid",
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
      dateFilterStart = new Date(startDate);
      dateFilterEnd = new Date(endDate);

      dateFilterStart.setHours(0, 0, 0, 0);
      dateFilterEnd.setHours(23, 59, 59, 999);
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

    const todayStart =
      dateFilterStart || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    if (!dateFilterStart) {
      todayStart.setHours(0, 0, 0, 0);
    }
    const todayEnd = dateFilterEnd || new Date();
    if (!dateFilterEnd) {
      todayEnd.setHours(23, 59, 59, 999);
    }

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);
    weekStart.setHours(0, 0, 0, 0);

    const monthStart = new Date();
    monthStart.setDate(monthStart.getDate() - 30);
    monthStart.setHours(0, 0, 0, 0);

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
          AND inv.status = 'Paid'
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
          status: "Paid",
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
          status: "Paid",
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
        WHERE inv.branch_id = :branchId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
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
          AND inv.status = 'Paid'
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
          status: "Paid",
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
          status: "Paid",
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
          status: "Paid",
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
        WHERE inv.branch_id = :branchId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
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
          status: "Paid",
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
    const branchSalesToday = parseFloat(branchTotals.total_sales || 0);
    const totalMetersToday = parseFloat(branchTotals.total_meters || 0);
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
        AND inv.status = 'Paid'
      `,
      {
        replacements: { branchId, dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );
    const totalCostToday = parseFloat(branchCost.total_cost || 0);

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
    const cacheKey = `dashboard:salesman:${req.tenant.slug}:${userId}`;

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

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const [myTotals = {}] = await sequelize.query(
      `
      SELECT
        COALESCE(SUM(inv.total_amount), 0) AS my_sales_today,
        COUNT(*)::int AS invoice_count
      FROM "${schema}".invoices inv
      WHERE inv.created_by = :userId
        AND inv.created_at >= :todayStart
        AND inv.status = 'Paid'
      `,
      {
        replacements: { userId, todayStart },
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
        AND inv.status = 'Paid'
      `,
      {
        replacements: { userId, todayStart },
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
        status: "Paid",
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
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
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
        AND inv.status = 'Paid'
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
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
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

        const dateFilter = {
          createdAt: { [Op.between]: [startDateObj, endDateObj] },
          status: "Paid",
        };
        const combinedFilter = { ...dateFilter, ...branchFilter };

        logger.info("Fetching period data", {
          component: "dashboard",
          startDate: start,
          endDate: end,
          daysDiff: Math.ceil(
            (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24),
          ),
          tenant: req.tenant.slug,
        });

        const totalRevenue =
          (await Invoice.schema(schema).sum("total_amount", {
            where: combinedFilter,
          })) || 0;
        const totalMetersSold =
          (await Invoice.schema(schema).sum("total_meters", {
            where: combinedFilter,
          })) || 0;
        const totalTransactions =
          (await Invoice.schema(schema).count({ where: combinedFilter })) || 0;

        const soldItems = await InvoiceItem.schema(schema).findAll({
          include: [
            {
              model: Invoice.schema(schema),
              where: combinedFilter,
              attributes: [],
            },
            {
              model: InventoryItem.schema(schema),
              as: "inventory_item",
              attributes: ["cost_per_meter"],
            },
          ],
          attributes: ["total_price", "meters", "quantity"],
        });

        let totalCost = 0;
        soldItems.forEach((item) => {
          totalCost +=
            parseFloat(item.inventory_item?.cost_per_meter || 0) *
            parseFloat(item.meters || 0) *
            (parseInt(item.quantity, 10) || 1);
        });

        const grossProfit = totalRevenue - totalCost;
        const totalQuantity = soldItems.length;

        const daysDiff = Math.ceil(
          (endDateObj - startDateObj) / (1000 * 60 * 60 * 24),
        );

        let groupBy;
        let salesTrendRaw;

        if (daysDiff <= 30) {

          groupBy = Sequelize.fn("DATE", Sequelize.col("created_at"));
          salesTrendRaw = await Invoice.schema(schema).findAll({
            attributes: [
              [groupBy, "date"],
              [Sequelize.fn("SUM", Sequelize.col("total_amount")), "revenue"],
              [Sequelize.fn("SUM", Sequelize.col("total_meters")), "meters"],
              [Sequelize.fn("COUNT", Sequelize.col("id")), "quantity"],
            ],
            where: combinedFilter,
            group: [groupBy],
            order: [[groupBy, "ASC"]],
            raw: true,
          });
        } else {

          const truncType = daysDiff <= 90 ? "week" : "month";
          let query = `
            SELECT
              DATE_TRUNC('${truncType}', created_at) AS date,
              SUM(total_amount) AS revenue,
              SUM(total_meters) AS meters,
              COUNT(id) AS quantity
            FROM "${schema}".invoices
            WHERE created_at BETWEEN :start AND :end
            AND status = 'Paid'
          `;

          const replacements = {
            start: startDateObj,
            end: endDateObj,
          };

          if (branchFilter.branch_id) {
            if (branchFilter.branch_id[Op.in]) {
              query += ` AND branch_id IN (:branchIds)`;
              replacements.branchIds = branchFilter.branch_id[Op.in];
            } else if (typeof branchFilter.branch_id === "number") {
              query += ` AND branch_id = :branchId`;
              replacements.branchId = branchFilter.branch_id;
            }
          }

          query += ` GROUP BY DATE_TRUNC('${truncType}', created_at) ORDER BY DATE_TRUNC('${truncType}', created_at) ASC`;

          salesTrendRaw = await sequelize.query(query, {
            replacements,
            type: sequelize.QueryTypes.SELECT,
          });

          groupBy = Sequelize.literal(`DATE_TRUNC('${truncType}', created_at)`);
        }

        const allDayItems = await InvoiceItem.schema(schema).findAll({
          include: [
            {
              model: Invoice.schema(schema),
              where: combinedFilter,
              attributes: ["id", "created_at"],
            },
            {
              model: InventoryItem.schema(schema),
              as: "inventory_item",
              attributes: ["cost_per_meter"],
            },
          ],
          attributes: ["total_price", "meters", "invoice_id"],
        });

        const itemsByDate = {};
        allDayItems.forEach((item) => {
          if (item.invoice && item.invoice.created_at) {
            const invoiceDate = new Date(item.invoice.created_at);
            let groupKey;

            if (daysDiff <= 30) {

              groupKey = invoiceDate.toISOString().split("T")[0];
            } else if (daysDiff <= 90) {

              const weekStart = new Date(invoiceDate);
              const dayOfWeek = invoiceDate.getDay();
              const diff =
                invoiceDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
              weekStart.setDate(diff);
              weekStart.setHours(0, 0, 0, 0);
              groupKey = weekStart.toISOString().split("T")[0];
            } else {

              const monthStart = new Date(
                invoiceDate.getFullYear(),
                invoiceDate.getMonth(),
                1,
              );
              groupKey = monthStart.toISOString().split("T")[0];
            }

            if (!itemsByDate[groupKey]) {
              itemsByDate[groupKey] = [];
            }
            itemsByDate[groupKey].push(item);
          }
        });

        const salesTrendWithProfit = salesTrendRaw.map((period) => {

          let periodKey;
          if (period.date) {
            const periodDate = new Date(period.date);
            if (daysDiff <= 30) {
              periodKey = periodDate.toISOString().split("T")[0];
            } else if (daysDiff <= 90) {

              const weekStart = new Date(periodDate);
              const dayOfWeek = periodDate.getDay();
              const diff =
                periodDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
              weekStart.setDate(diff);
              weekStart.setHours(0, 0, 0, 0);
              periodKey = weekStart.toISOString().split("T")[0];
            } else {

              const monthStart = new Date(
                periodDate.getFullYear(),
                periodDate.getMonth(),
                1,
              );
              periodKey = monthStart.toISOString().split("T")[0];
            }
          }

          const periodItems = itemsByDate[periodKey] || [];
          let periodCost = 0;
          periodItems.forEach((item) => {
            periodCost +=
              parseFloat(item.inventory_item?.cost_per_meter || 0) *
              parseFloat(item.meters);
          });

          return {
            date: period.date,
            revenue: parseFloat(period.revenue) || 0,
            profit: (parseFloat(period.revenue) || 0) - periodCost,
            meters: parseFloat(period.meters ?? period.meters) || 0,
            quantity: parseInt(period.quantity) || 0,
          };
        });

        let categoryQuery = `
          SELECT ii.fabric_type AS name, SUM(it.total_price) AS revenue, COUNT(it.id) AS quantity
          FROM "${schema}".invoice_items it
          INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
          INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
          WHERE inv.created_at BETWEEN :start AND :end
        `;

        const categoryReplacements = {
          start: startDateObj,
          end: endDateObj,
        };

        if (branchFilter.branch_id) {
          if (branchFilter.branch_id[Op.in]) {
            categoryQuery += ` AND inv.branch_id IN (:branchIds)`;
            categoryReplacements.branchIds = branchFilter.branch_id[Op.in];
          } else if (typeof branchFilter.branch_id === "number") {
            categoryQuery += ` AND inv.branch_id = :branchId`;
            categoryReplacements.branchId = branchFilter.branch_id;
          }
        }

        categoryQuery += ` GROUP BY ii.fabric_type ORDER BY SUM(it.total_price) DESC`;

        const categoryRaw = await sequelize.query(categoryQuery, {
          replacements: categoryReplacements,
          type: sequelize.QueryTypes.SELECT,
        });

        const allCategoryItems = await InvoiceItem.schema(schema).findAll({
          include: [
            {
              model: Invoice.schema(schema),
              where: combinedFilter,
              attributes: [],
            },
            {
              model: InventoryItem.schema(schema),
              as: "inventory_item",
              attributes: ["cost_per_meter", "pattern"],
            },
          ],
          attributes: ["total_price", "meters", "quantity"],
        });

        const itemsByCategory = {};
        allCategoryItems.forEach((item) => {
          const pattern = item.inventory_item?.pattern;
          if (pattern) {
            if (!itemsByCategory[pattern]) {
              itemsByCategory[pattern] = [];
            }
            itemsByCategory[pattern].push(item);
          }
        });

        const categoryDistribution = categoryRaw.map((cat) => {
          const catItems = itemsByCategory[cat.name] || [];
          let catCost = 0;
          catItems.forEach((item) => {
            catCost +=
              parseFloat(item.inventory_item?.cost_per_meter || 0) *
              parseFloat(item.meters);
          });

          return {
            name: cat.name,
            revenue: parseFloat(cat.revenue) || 0,
            profit: (parseFloat(cat.revenue) || 0) - catCost,
            quantity: parseInt(cat.quantity) || 0,
          };
        });

        let fabricQuery = `
          SELECT it.fabric_type, SUM(it.total_price) AS revenue, COUNT(it.id) AS quantity, SUM(it.meters * COALESCE(it.quantity,1)) AS meters
          FROM "${schema}".invoice_items it
          INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
          INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
          WHERE inv.created_at BETWEEN :start AND :end
            AND it.fabric_type IS NOT NULL
        `;

        const fabricReplacements = {
          start: startDateObj,
          end: endDateObj,
        };

        if (branchFilter.branch_id) {
          if (branchFilter.branch_id[Op.in]) {
            fabricQuery += ` AND inv.branch_id IN (:branchIds)`;
            fabricReplacements.branchIds = branchFilter.branch_id[Op.in];
          } else if (typeof branchFilter.branch_id === "number") {
            fabricQuery += ` AND inv.branch_id = :branchId`;
            fabricReplacements.branchId = branchFilter.branch_id;
          }
        }

        fabricQuery += `
          AND it.fabric_type IS NOT NULL
          GROUP BY it.fabric_type
          ORDER BY it.fabric_type ASC`;

        const fabricRaw = await sequelize.query(fabricQuery, {
          replacements: fabricReplacements,
          type: sequelize.QueryTypes.SELECT,
        });

        const allFabricItems = await InvoiceItem.schema(schema).findAll({
          include: [
            {
              model: InventoryItem.schema(schema),
              as: "inventory_item",
              attributes: ["cost_per_meter", "fabric_type"],
            },
          ],
          attributes: ["total_price", "meters"],
        });

        const itemsByFabric = {};
        allFabricItems.forEach((item) => {
          const fabricKey = item.inventory_item?.fabric_type || "Other";
          if (!itemsByFabric[fabricKey]) itemsByFabric[fabricKey] = [];
          itemsByFabric[fabricKey].push(item);
        });

        const fabricDistribution = fabricRaw.map((row) => {
          const fabricKey = row.fabric_type || "Other";
          const fabricItems = itemsByFabric[fabricKey] || [];
          let fabricCost = 0;
          fabricItems.forEach((item) => {
            fabricCost +=
              parseFloat(item.inventory_item?.cost_per_meter || 0) *
              (parseFloat(item.meters) || 0);
          });

          return {
            fabric_type: fabricKey,
            revenue: parseFloat(row.revenue) || 0,
            profit: (parseFloat(row.revenue) || 0) - fabricCost,
            quantity: parseInt(row.quantity) || 0,
            meters: parseFloat(row.meters) || 0,
          };
        });

        const branchRaw = await Invoice.schema(schema).findAll({
          attributes: [
            "branch_id",
            [Sequelize.fn("SUM", Sequelize.col("total_amount")), "revenue"],
            [Sequelize.fn("COUNT", Sequelize.col("id")), "quantity"],
          ],
          where: combinedFilter,
          group: ["branch_id"],
          raw: true,
        });

        const [branches, allBranchItems] = await Promise.all([
          Branch.schema(schema).findAll({
            where: {
              id: { [Op.in]: branchRaw.map((bp) => bp.branch_id) },
            },
            attributes: ["id", "name"],
          }),
          InvoiceItem.schema(schema).findAll({
            include: [
              {
                model: Invoice.schema(schema),
                where: combinedFilter,
                attributes: ["id", "branch_id"],
              },
              {
                model: InventoryItem.schema(schema),
                as: "inventory_item",
                attributes: ["cost_per_meter"],
              },
            ],
            attributes: ["total_price", "meters", "invoice_id"],
          }),
        ]);

        const branchMap = {};
        branches.forEach((b) => {
          branchMap[b.id] = b.name;
        });

        const itemsByBranch = {};
        allBranchItems.forEach((item) => {
          const branchId = item.invoice?.branch_id;
          if (branchId) {
            if (!itemsByBranch[branchId]) {
              itemsByBranch[branchId] = [];
            }
            itemsByBranch[branchId].push(item);
          }
        });

        const branchPerformance = branchRaw.map((bp) => {
          const branchItems = itemsByBranch[bp.branch_id] || [];
          let branchCost = 0;
          branchItems.forEach((item) => {
            branchCost +=
              parseFloat(item.inventory_item?.cost_per_meter || 0) *
              parseFloat(item.meters);
          });

          return {
            name: branchMap[bp.branch_id] || "Unknown",
            revenue: parseFloat(bp.revenue) || 0,
            profit: (parseFloat(bp.revenue) || 0) - branchCost,
            quantity: parseInt(bp.quantity) || 0,
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

    const cacheKey = `analytics:${req.tenant.slug}:${startDate}:${endDate}:${branchIds || "all"}`;
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

    let branchFilter = {};
    if (branchIds) {
      const branchArray = branchIds.split(",").map((id) => parseInt(id));
      if (branchArray.length > 0) {
        branchFilter.branch_id = { [Op.in]: branchArray };
      }
    }

    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = { [Op.between]: [startDate, endDate] };
    }

    const combinedFilter = { ...dateFilter, ...branchFilter };

    const topItems = await sequelize.query(
      `
      SELECT
        ii.id,
        ii.item_name AS name,
        ii.fabric_type,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity,
        SUM(it.meters * COALESCE(it.quantity,1)) AS meters
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_at BETWEEN :startDate AND :endDate
      ${branchFilter.branch_id ? `AND inv.branch_id IN (:branchIds)` : ""}
      GROUP BY ii.id, ii.item_name, it.fabric_type, it.color, ii.fabric_type
      ORDER BY revenue DESC
      LIMIT :limit
    `,
      {
        replacements: {
          startDate: dateFilter.createdAt?.[Op.between]?.[0] || new Date(0),
          endDate: dateFilter.createdAt?.[Op.between]?.[1] || new Date(),
          branchIds: branchFilter.branch_id?.[Op.in] || [],
          limit: parseInt(limit) * 2,
        },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const itemIds = topItems.map((item) => item.id);
    const allItemDetails = await InvoiceItem.schema(schema).findAll({
      include: [
        {
          model: Invoice.schema(schema),
          where: combinedFilter,
          attributes: [],
        },
        {
          model: InventoryItem.schema(schema),
          as: "inventory_item",
          where: { id: { [Op.in]: itemIds } },
          attributes: ["id", "cost_per_meter", "fabric_type"],
        },
      ],
      attributes: ["total_price", "meters", "inventory_item_id"],
    });

    const detailsByItemId = {};
    allItemDetails.forEach((detail) => {
      const itemId = detail.inventory_item_id;
      if (itemId) {
        if (!detailsByItemId[itemId]) {
          detailsByItemId[itemId] = [];
        }
        detailsByItemId[itemId].push(detail);
      }
    });

    const inventoryItemsById = {};
    allItemDetails.forEach((detail) => {
      if (detail.inventory_item) {
        inventoryItemsById[detail.inventory_item.id] = detail.inventory_item;
      }
    });

    const itemsWithProfit = topItems.map((item) => {
      const itemDetails = detailsByItemId[item.id] || [];
      const inventoryItem = inventoryItemsById[item.id];

      let cost = 0;
      itemDetails.forEach((detail) => {
        const buyPrice = parseFloat(detail.inventory_item?.cost_per_meter || 0);
        const meters =
          parseFloat(detail.meters || 0) *
          (parseInt(detail.quantity, 10) || 1);
        cost += buyPrice * meters;
      });
      void inventoryItem;

      return {
        id: item.id,
        name: item.name,
        pattern: item.pattern,
        fabric_type: item.fabric_type || null,
        revenue: parseFloat(item.revenue) || 0,
        profit: (parseFloat(item.revenue) || 0) - cost,
        quantity: parseInt(item.quantity) || 0,
        meters: parseFloat(item.meters) || 0,
      };
    });

    itemsWithProfit.sort((a, b) => b[metric] - a[metric]);

    res.json({
      success: true,
      data: itemsWithProfit.slice(0, parseInt(limit)),
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
