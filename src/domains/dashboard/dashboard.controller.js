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
import { cacheGet, cacheSet } from "../../config/redis.js";

export const getOwnerDashboard = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;

    // Get date range from query params if provided
    const { startDate, endDate } = req.query;
    let dateFilterStart = null;
    let dateFilterEnd = null;

    if (startDate && endDate) {
      dateFilterStart = new Date(startDate);
      dateFilterEnd = new Date(endDate);
      // Set time to start/end of day
      dateFilterStart.setHours(0, 0, 0, 0);
      dateFilterEnd.setHours(23, 59, 59, 999);
    }

    const cacheKey = `dashboard:owner:${req.tenant.slug}:${startDate || "today"}:${endDate || "today"}`;

    // Try to get from cache (Redis or in-memory fallback) - only if no custom date range
    if (!startDate && !endDate) {
      const dashboardData = await cacheGet(cacheKey);
      if (dashboardData) {
        logger.info("Owner dashboard served from cache", {
          component: "dashboard",
          tenant: req.tenant.slug,
          requestId: req.requestId,
        });
        return res.json({
          success: true,
          data: {
            ...dashboardData,
          },
        });
      }
    }

    // Fallback to database if cache miss or Redis unavailable
    logger.info("Owner dashboard fetching from database", {
      component: "dashboard",
      tenant: req.tenant.slug,
      startDate: dateFilterStart?.toISOString(),
      endDate: dateFilterEnd?.toISOString(),
      requestId: req.requestId,
    });

    // Use custom date range if provided, otherwise use today
    const todayStart = dateFilterStart || new Date();
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

    const invoicesToday = await Invoice.schema(schema).findAll({
      where: {
        createdAt: { [Op.between]: [todayStart, todayEnd] },
        status: "Paid",
      },
      include: [{ model: InvoiceItem.schema(schema), as: "items" }],
    });

    let totalSalesToday = 0;
    let totalMetersToday = 0;
    let totalCostToday = 0;
    const fabricTotals = new Map();

    invoicesToday.forEach((inv) => {
      totalSalesToday += parseFloat(inv.total_amount || 0);
      totalMetersToday += parseFloat(inv.total_meters || 0);

      inv.items.forEach((item) => {
        const lineMeters =
          parseFloat(item.meters || 0) * (parseInt(item.quantity, 10) || 1);
        const costPerMeter = parseFloat(item.cost_per_meter_snapshot || 0);
        const lineRevenue = parseFloat(item.total_price || 0);
        totalCostToday += lineMeters * costPerMeter;

        const key = item.fabric_type || "Other";
        const current = fabricTotals.get(key) || {
          name: key,
          meters: 0,
          revenue: 0,
          profit: 0,
        };
        current.meters += lineMeters;
        current.revenue += lineRevenue;
        current.profit += lineRevenue - lineMeters * costPerMeter;
        fabricTotals.set(key, current);
      });
    });

    const topFabrics = Array.from(fabricTotals.values())
      .sort((a, b) => b.revenue - a.revenue)
      .slice(0, 5)
      .map((fabric) => ({
        name: fabric.name,
        fabric_type: fabric.name,
        meters: Math.round(fabric.meters * 1000) / 1000,
        revenue: Math.round(fabric.revenue * 1000) / 1000,
        profit: Math.round(fabric.profit * 1000) / 1000,
      }));

    const netProfitToday = totalSalesToday - totalCostToday;
    const avgSaleValue =
      invoicesToday.length > 0 ? totalSalesToday / invoicesToday.length : 0;

    // Month-to-date fabric KPIs (last 30 days)
    const monthInvoices = await Invoice.schema(schema).findAll({
      where: {
        createdAt: { [Op.gte]: monthStart },
        status: "Paid",
      },
      attributes: ["total_amount", "total_meters"],
    });
    const monthSales = monthInvoices.reduce(
      (sum, inv) => sum + parseFloat(inv.total_amount || 0),
      0,
    );
    const monthMeters = monthInvoices.reduce(
      (sum, inv) => sum + parseFloat(inv.total_meters || 0),
      0,
    );

    // Total Inventory Value
    const inventoryItems = await InventoryItem.schema(schema).findAll({
      where: { status: "In Stock" },
      attributes: ["length_m", "cost_per_meter", "quantity"],
    });

    let totalInventoryValue = 0;
    inventoryItems.forEach((item) => {
      const value =
        parseFloat(item.length_m || 0) *
        parseFloat(item.cost_per_meter || 0) *
        parseInt(item.quantity || 1);
      totalInventoryValue += value;
    });

    // Active Branches Count (count all branches, as there's no is_active field)
    const activeBranches = await Branch.schema(schema).count();

    const whatsappConfig = await WhatsappConfig.findOne({
      where: { tenant_slug: req.tenant.slug },
    });

    // Sales Trend (7 days)
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

    // Sales Trend (30 days)
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

    // Sales by Branch (only if >1 branch)
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

    // Sales by Category + Karat (combined)
    // For Watch and Diamond, don't include karat in the name
    const categoryKaratSales = await sequelize.query(
      `
      SELECT 
        CASE 
          WHEN ii.fabric_type IN ('Watch', 'Diamond') THEN ii.fabric_type
          ELSE CONCAT(ii.fabric_type, ' ', it.fabric_type, 'K')
        END AS name,
        ii.fabric_type,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        SUM(
          CASE 
            WHEN ii.fabric_type IN ('Watch', 'Diamond') THEN COALESCE(ii.cost_per_meter, 0)
            ELSE (COALESCE(it.cost_per_meter_snapshot, 0) * (COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)))
          END
        ) AS cost,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_at >= :dateStart 
        AND inv.created_at <= :dateEnd 
        AND inv.status = 'Paid'
      GROUP BY ii.fabric_type, it.fabric_type, ii.fabric_type
      ORDER BY revenue DESC
    `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const categoryKaratWithProfit = categoryKaratSales.map((item) => ({
      name: item.name,
      category: item.category,
      fabric_type: item.fabric_type || null,
      revenue: parseFloat(item.revenue || 0),
      profit: parseFloat(item.revenue || 0) - parseFloat(item.cost || 0),
      quantity: parseInt(item.quantity || 0),
    }));

    // Sales by Karat (only for Gold, Silver, Platinum - exclude Watch and Diamond)
    const karatSales = await sequelize.query(
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
        AND ii.fabric_type NOT IN ('Watch', 'Diamond')
      GROUP BY it.fabric_type
      ORDER BY it.fabric_type DESC
    `,
      {
        replacements: { dateStart: todayStart, dateEnd: todayEnd },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Top 5 Selling Items (by Revenue)
    const topItemsRevenue = await sequelize.query(
      `
      SELECT 
        ii.id,
        ii.item_name AS name,
        ii.fabric_type,
        ii.fabric_type,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        SUM(
          CASE 
            WHEN ii.fabric_type IN ('Watch', 'Diamond') THEN COALESCE(ii.cost_per_meter, 0)
            ELSE (COALESCE(it.cost_per_meter_snapshot, 0) * (COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)))
          END
        ) AS cost,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_at >= :dateStart 
        AND inv.created_at <= :dateEnd 
        AND inv.status = 'Paid'
      GROUP BY ii.id, ii.item_name, ii.fabric_type, it.fabric_type, ii.fabric_type
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
      category: item.category,
      fabric_type: item.fabric_type || null,
      revenue: parseFloat(item.revenue || 0),
      profit: parseFloat(item.revenue || 0) - parseFloat(item.cost || 0),
      quantity: parseInt(item.quantity || 0),
    }));

    // Top 5 Customers (by value)
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

    // Low Stock Items
    const lowStockItems = await InventoryItem.schema(schema).findAll({
      where: {
        status: "In Stock",
        quantity: { [Op.lte]: Sequelize.col("min_stock_level") },
      },
      attributes: [
        "id",
        "item_name",
        "category",
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
        invoice_count: invoicesToday.length,
        avg_sale_value: avgSaleValue.toFixed(3),
        month_sales: monthSales.toFixed(3),
        month_invoices: monthInvoices.length,
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
        sales_by_category_karat: categoryKaratWithProfit,
        sales_by_karat: karatSales.map((k) => ({
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
          category: i.category,
          quantity: i.quantity,
          min_stock_level: i.min_stock_level,
        })),
      },
      last_updated: new Date().toISOString(),
    };

    // Cache result (Redis or in-memory) when no custom date range
    if (!startDate && !endDate) {
      await cacheSet(cacheKey, dashboardData, 60); // 60 seconds TTL
    }

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

    // Get date range from query params if provided
    const { startDate, endDate } = req.query;
    let dateFilterStart = null;
    let dateFilterEnd = null;

    if (startDate && endDate) {
      dateFilterStart = new Date(startDate);
      dateFilterEnd = new Date(endDate);
      // Set time to start/end of day
      dateFilterStart.setHours(0, 0, 0, 0);
      dateFilterEnd.setHours(23, 59, 59, 999);
    }

    const cacheKey = `dashboard:manager:${req.tenant.slug}:${branchId}:${startDate || "today"}:${endDate || "today"}`;

    // Try to get from cache (Redis or in-memory) - only if no custom date range
    if (!startDate && !endDate) {
      const dashboardData = await cacheGet(cacheKey);
      if (dashboardData) {
        logger.info("Manager dashboard served from cache", {
          component: "dashboard",
          tenant: req.tenant.slug,
          branchId,
          requestId: req.requestId,
        });
        return res.json({
          success: true,
          data: {
            ...dashboardData,
          },
        });
      }
    }

    // Fallback to database if cache miss or Redis unavailable
    logger.info("Manager dashboard fetching from database", {
      component: "dashboard",
      tenant: req.tenant.slug,
      branchId,
      startDate: dateFilterStart?.toISOString(),
      endDate: dateFilterEnd?.toISOString(),
      requestId: req.requestId,
    });

    // Use custom date range if provided, otherwise use today
    const todayStart = dateFilterStart || new Date();
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
      branchInvoicesToday,
      lowStockItems,
      salesTrend7Days,
      salesTrend30Days,
      categoryKaratSales,
      karatSales,
      staffPerformanceToday,
      staffPerformanceWeek,
      staffPerformanceMonth,
      topItemsRevenue,
      topCustomers,
    ] = await Promise.all([
      // 1. branchInvoicesToday
      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.between]: [todayStart, todayEnd] },
          status: "Paid",
        },
        include: [{ model: InvoiceItem.schema(schema), as: "items" }],
      }),
      // 2. lowStockItems
      InventoryItem.schema(schema).findAll({
        where: {
          branch_id: branchId,
          status: "In Stock",
          quantity: { [Op.lte]: Sequelize.col("min_stock_level") },
        },
        attributes: [
          "id",
          "item_name",
          "category",
          "quantity",
          "min_stock_level",
        ],
        limit: 20,
      }),
      // 3. salesTrend7Days
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
      // 4. salesTrend30Days
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
      // 5. categoryKaratSales
      sequelize.query(
        `
        SELECT 
          CASE 
            WHEN ii.fabric_type IN ('Watch', 'Diamond') THEN ii.fabric_type
            ELSE CONCAT(ii.fabric_type, ' ', it.fabric_type, 'K')
          END AS name,
          ii.fabric_type,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.branch_id = :branchId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
        GROUP BY ii.fabric_type, it.fabric_type, ii.fabric_type
        ORDER BY revenue DESC
      `,
        {
          replacements: { branchId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      // 6. karatSales
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
          AND ii.fabric_type NOT IN ('Watch', 'Diamond')
        GROUP BY it.fabric_type
        ORDER BY it.fabric_type DESC
      `,
        {
          replacements: { branchId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      // 7. staffPerformanceToday
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
      // 8. staffPerformanceWeek
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
      // 9. staffPerformanceMonth
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
      // 10. topItemsRevenue
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
        GROUP BY ii.id, ii.item_name, ii.fabric_type, it.fabric_type
        ORDER BY revenue DESC
        LIMIT 5
      `,
        {
          replacements: { branchId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      // 11. topCustomers
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

    let branchSalesToday = 0;
    let totalMetersToday = 0;
    let totalCostToday = 0;

    branchInvoicesToday.forEach((inv) => {
      branchSalesToday += parseFloat(inv.total_amount || 0);
      totalMetersToday += parseFloat(inv.total_meters || 0);
      inv.items.forEach((item) => {
        const lineMeters =
          parseFloat(item.meters || 0) * (parseInt(item.quantity, 10) || 1);
        const costPerMeter = parseFloat(item.cost_per_meter_snapshot || 0);
        totalCostToday += lineMeters * costPerMeter;
      });
    });

    const netProfitToday = branchSalesToday - totalCostToday;
    const avgSaleValue =
      branchInvoicesToday.length > 0
        ? branchSalesToday / branchInvoicesToday.length
        : 0;



    const dashboardData = {
      kpi: {
        branch_sales: branchSalesToday.toFixed(3),
        net_profit: netProfitToday.toFixed(3),
        total_meters: totalMetersToday.toFixed(3),
        invoice_count: branchInvoicesToday.length,
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
        salesByCategoryKarat: categoryKaratSales.map((c) => ({
          name: c.name,
          revenue: parseFloat(c.revenue || 0),
          quantity: parseInt(c.quantity || 0),
        })),
        salesByKarat: karatSales.map((k) => ({
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
          category: i.category,
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
          category: i.category,
          quantity: i.quantity,
          min_stock_level: i.min_stock_level,
        })),
      },
      last_updated: new Date().toISOString(),
    };

    // Cache result when no custom date range
    if (!startDate && !endDate) {
      await cacheSet(cacheKey, dashboardData, 60);
    }

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

    // Try to get from cache (Redis or in-memory)
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

    // Fallback to database if cache miss or Redis unavailable
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

    const invoicesToday = await Invoice.schema(schema).findAll({
      where: {
        created_by: userId,
        createdAt: { [Op.gte]: todayStart },
        status: "Paid",
      },
      include: [{ model: InvoiceItem.schema(schema), as: "items" }],
    });

    let mySalesToday = 0;
    let itemsSoldCount = 0;
    invoicesToday.forEach((inv) => {
      mySalesToday += parseFloat(inv.total_amount || 0);
      itemsSoldCount += inv.items.length;
    });

    const avgSaleValue =
      invoicesToday.length > 0 ? mySalesToday / invoicesToday.length : 0;

    // Sales Trend (7 days)
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

    // Sales by Category + Karat
    const categoryKaratSales = await sequelize.query(
      `
      SELECT 
        CASE 
          WHEN ii.fabric_type IN ('Watch', 'Diamond') THEN ii.fabric_type
          ELSE CONCAT(ii.fabric_type, ' ', it.fabric_type, 'K')
        END AS name,
        ii.fabric_type,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY ii.fabric_type, it.fabric_type, ii.fabric_type
      ORDER BY revenue DESC
    `,
      {
        replacements: { userId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Sales by Karat (only for Gold, Silver, Platinum - exclude Watch and Diamond)
    const karatSales = await sequelize.query(
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
        AND ii.fabric_type NOT IN ('Watch', 'Diamond')
      GROUP BY it.fabric_type
      ORDER BY it.fabric_type DESC
    `,
      {
        replacements: { userId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Top 5 Items I Sold
    const topItems = await sequelize.query(
      `
      SELECT 
        ii.id,
        ii.item_name AS name,
        ii.fabric_type,
        ii.fabric_type,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY ii.id, ii.item_name, ii.fabric_type, it.fabric_type, ii.fabric_type
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
        sales_by_category_karat: categoryKaratSales.map((c) => ({
          name: c.name,
          revenue: parseFloat(c.revenue || 0),
          quantity: parseInt(c.quantity || 0),
        })),
        sales_by_karat: karatSales.map((k) => ({
          fabric_type: k.fabric_type || null,
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        top_5_items: topItems.map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          fabric_type: i.fabric_type || null,
          revenue: parseFloat(i.revenue || 0),
          quantity: parseInt(i.quantity || 0),
        })),
      },
      last_updated: new Date().toISOString(),
    };

    // Cache result
    await cacheSet(cacheKey, dashboardData, 60);

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

    // Validate required parameters
    if (!startDate || !endDate) {
      return res.status(400).json({
        message: "startDate and endDate are required",
      });
    }

    // Validate date format
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

    // ✅ SECURITY FIX: If user is branch_manager or sales_man, restrict to their branch only
    let branchFilter = {};
    if (req.user.role === "branch_manager" || req.user.role === "sales_man") {
      // Force branch_manager and sales_man to only see their own branch
      branchFilter.branch_id = req.user.branch_id;
    } else if (branchIds) {
      // For store_owner, allow selecting multiple branches
      const branchArray = Array.isArray(branchIds)
        ? branchIds
        : branchIds.split(",").map((id) => parseInt(id));
      if (branchArray.length > 0) {
        branchFilter.branch_id = { [Op.in]: branchArray };
      }
    }

    const fetchPeriodData = async (start, end) => {
      try {
        // Ensure dates are Date objects
        const startDateObj = start instanceof Date ? start : new Date(start);
        const endDateObj = end instanceof Date ? end : new Date(end);

        if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
          throw new Error("Invalid date range provided");
        }

        const dateFilter = {
          createdAt: { [Op.between]: [startDateObj, endDateObj] },
          status: "Paid", // Only count paid invoices
        };
        const combinedFilter = { ...dateFilter, ...branchFilter };

        // Debug: Log the date range being queried
        logger.info("Fetching period data", {
          component: "dashboard",
          startDate: start,
          endDate: end,
          daysDiff: Math.ceil(
            (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24),
          ),
          tenant: req.tenant.slug,
        });

        // 1. KPI Cards
        const totalRevenue =
          (await Invoice.schema(schema).sum("total_amount", {
            where: combinedFilter,
          })) || 0;
        const totalWeightSold =
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

        // 2. Sales Trend - Smart grouping based on date range
        const daysDiff = Math.ceil(
          (endDateObj - startDateObj) / (1000 * 60 * 60 * 24),
        );

        let groupBy;
        let salesTrendRaw;

        if (daysDiff <= 30) {
          // Daily grouping for <= 30 days
          groupBy = Sequelize.fn("DATE", Sequelize.col("created_at"));
          salesTrendRaw = await Invoice.schema(schema).findAll({
            attributes: [
              [groupBy, "date"],
              [Sequelize.fn("SUM", Sequelize.col("total_amount")), "revenue"],
              [Sequelize.fn("SUM", Sequelize.col("total_meters")), "weight"],
              [Sequelize.fn("COUNT", Sequelize.col("id")), "quantity"],
            ],
            where: combinedFilter,
            group: [groupBy],
            order: [[groupBy, "ASC"]],
            raw: true,
          });
        } else {
          // Weekly or Monthly grouping - use raw SQL query
          const truncType = daysDiff <= 90 ? "week" : "month";
          let query = `
            SELECT 
              DATE_TRUNC('${truncType}', created_at) AS date,
              SUM(total_amount) AS revenue,
              SUM(total_meters) AS weight,
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

          // Set groupBy for later use (for date formatting)
          groupBy = Sequelize.literal(`DATE_TRUNC('${truncType}', created_at)`);
        }

        // Optimize: Fetch all items with inventory data in one query instead of N+1
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
          attributes: ["total_price", "weight", "invoice_id"],
        });

        // Group items by date (support daily, weekly, monthly)
        const itemsByDate = {};
        allDayItems.forEach((item) => {
          if (item.invoice && item.invoice.created_at) {
            const invoiceDate = new Date(item.invoice.created_at);
            let groupKey;

            if (daysDiff <= 30) {
              // Daily grouping
              groupKey = invoiceDate.toISOString().split("T")[0];
            } else if (daysDiff <= 90) {
              // Weekly grouping - get start of week (Monday)
              const weekStart = new Date(invoiceDate);
              const dayOfWeek = invoiceDate.getDay();
              const diff =
                invoiceDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1); // Adjust to Monday
              weekStart.setDate(diff);
              weekStart.setHours(0, 0, 0, 0);
              groupKey = weekStart.toISOString().split("T")[0];
            } else {
              // Monthly grouping - get start of month
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
          // Normalize date format for matching
          let periodKey;
          if (period.date) {
            const periodDate = new Date(period.date);
            if (daysDiff <= 30) {
              periodKey = periodDate.toISOString().split("T")[0];
            } else if (daysDiff <= 90) {
              // Weekly - get start of week
              const weekStart = new Date(periodDate);
              const dayOfWeek = periodDate.getDay();
              const diff =
                periodDate.getDate() - dayOfWeek + (dayOfWeek === 0 ? -6 : 1);
              weekStart.setDate(diff);
              weekStart.setHours(0, 0, 0, 0);
              periodKey = weekStart.toISOString().split("T")[0];
            } else {
              // Monthly - get start of month
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
            weight: parseFloat(period.meters ?? period.weight) || 0,
            quantity: parseInt(period.quantity) || 0,
          };
        });

        // 3. Category Distribution
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

        // Optimize: Fetch all category items in one query
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
              attributes: ["cost_per_meter", "category"],
            },
          ],
          attributes: ["total_price", "meters", "quantity"],
        });

        // Group items by category
        const itemsByCategory = {};
        allCategoryItems.forEach((item) => {
          const category = item.inventory_item?.category;
          if (category) {
            if (!itemsByCategory[category]) {
              itemsByCategory[category] = [];
            }
            itemsByCategory[category].push(item);
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

        // 4. Karat Distribution (only for Gold, Silver, Platinum - exclude Watch and Diamond)
        let karatQuery = `
          SELECT it.fabric_type, SUM(it.total_price) AS revenue, COUNT(it.id) AS quantity, SUM(it.meters * COALESCE(it.quantity,1)) AS meters
          FROM "${schema}".invoice_items it
          INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
          INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
          WHERE inv.created_at BETWEEN :start AND :end
            AND it.fabric_type IS NOT NULL
            AND ii.fabric_type NOT IN ('Watch', 'Diamond')
        `;

        const karatReplacements = {
          start: startDateObj,
          end: endDateObj,
        };

        if (branchFilter.branch_id) {
          if (branchFilter.branch_id[Op.in]) {
            karatQuery += ` AND inv.branch_id IN (:branchIds)`;
            karatReplacements.branchIds = branchFilter.branch_id[Op.in];
          } else if (typeof branchFilter.branch_id === "number") {
            karatQuery += ` AND inv.branch_id = :branchId`;
            karatReplacements.branchId = branchFilter.branch_id;
          }
        }

        karatQuery += ` 
          AND it.fabric_type IS NOT NULL
          GROUP BY it.fabric_type 
          ORDER BY it.fabric_type DESC`;

        const fabricRaw = await sequelize.query(karatQuery, {
          replacements: karatReplacements,
          type: sequelize.QueryTypes.SELECT,
        });

        // Optimize: Fetch all karat items in one query
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

        // Group sold lines by fabric type
        const itemsByFabric = {};
        allFabricItems.forEach((item) => {
          const fabricKey = item.inventory_item?.fabric_type || "Other";
          if (!itemsByFabric[fabricKey]) itemsByFabric[fabricKey] = [];
          itemsByFabric[fabricKey].push(item);
        });

        const karatDistribution = fabricRaw.map((row) => {
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

        // 5. Branch Performance
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

        // Optimize: Fetch all branches and items in parallel
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
            attributes: ["total_price", "weight", "invoice_id"],
          }),
        ]);

        // Create branch lookup map
        const branchMap = {};
        branches.forEach((b) => {
          branchMap[b.id] = b.name;
        });

        // Group items by branch
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
            meters_sold: totalWeightSold,
            transactions: totalTransactions,
            quantity: totalQuantity,
          },
          charts: {
            sales_trend: salesTrendWithProfit,
            category_distribution: categoryDistribution,
            fabric_distribution: karatDistribution,
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

    // Determine data source (cache or live)
    const cacheKey = `analytics:${req.tenant.slug}:${startDate}:${endDate}:${branchIds || "all"}`;
    let dataSource = "live";
    let lastUpdated = new Date().toISOString();
    let nextUpdate = null;
    let currentPeriod = null;

    // Debug: Log the request parameters
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

    // Try to get from cache (Redis or in-memory)
    const cachedData = await cacheGet(cacheKey);
    if (cachedData) {
      if (cachedData && cachedData.current) {
        // Verify cached data matches requested date range
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

        // If cache exists and seems valid, use it
        dataSource = "cache";
        currentPeriod = cachedData.current;
        lastUpdated = cachedData.last_updated || lastUpdated;
        // Next update is 1 hour from last update
        const nextUpdateDate = new Date(lastUpdated);
        nextUpdateDate.setHours(nextUpdateDate.getHours() + 1);
        nextUpdate = nextUpdateDate.toISOString();
      } else {
        // Cache miss - fetch from database
        logger.info("Cache miss, fetching from database", {
          component: "dashboard",
          cacheKey,
        });
        currentPeriod = await fetchPeriodData(start, end);
        // Calculate next update (1 hour from now)
        const nextUpdateDate = new Date();
        nextUpdateDate.setHours(nextUpdateDate.getHours() + 1);
        nextUpdate = nextUpdateDate.toISOString();
      }
    } else {
      // Cache miss - fetch from database
      logger.debug("Cache miss, fetching from database", {
        component: "dashboard",
      });
      currentPeriod = await fetchPeriodData(start, end);
    }

    // If currentPeriod is still null (shouldn't happen, but safety check)
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

    // Handle both string 'true' and boolean true
    const shouldCompare = compare === "true" || compare === true;

    if (shouldCompare) {
      const currStart = new Date(startDate);
      const currEnd = new Date(endDate);

      let prevStart, prevEnd;

      // Calculate previous period based on compareType
      switch (compareType) {
        case "previous_week": {
          // Same day last week
          prevEnd = new Date(currEnd);
          prevEnd.setDate(prevEnd.getDate() - 7);
          prevStart = new Date(currStart);
          prevStart.setDate(prevStart.getDate() - 7);
          break;
        }
        case "previous_month": {
          // Same period last month
          prevEnd = new Date(currEnd);
          prevEnd.setMonth(prevEnd.getMonth() - 1);
          prevStart = new Date(currStart);
          prevStart.setMonth(prevStart.getMonth() - 1);
          break;
        }
        case "same_month_last_year": {
          // Same month last year
          prevEnd = new Date(currEnd);
          prevEnd.setFullYear(prevEnd.getFullYear() - 1);
          prevStart = new Date(currStart);
          prevStart.setFullYear(prevStart.getFullYear() - 1);
          break;
        }
        case "previous_quarter": {
          // Same period 3 months ago
          prevEnd = new Date(currEnd);
          prevEnd.setMonth(prevEnd.getMonth() - 3);
          prevStart = new Date(currStart);
          prevStart.setMonth(prevStart.getMonth() - 3);
          break;
        }
        case "previous_year": {
          // Same period last year
          prevEnd = new Date(currEnd);
          prevEnd.setFullYear(prevEnd.getFullYear() - 1);
          prevStart = new Date(currStart);
          prevStart.setFullYear(prevStart.getFullYear() - 1);
          break;
        }
        case "previous_period":
        default: {
          // Previous period with same duration (original logic)
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

    // Cache the result when data is live (Redis or in-memory fallback)
    if (dataSource === "live") {
      await cacheSet(
        cacheKey,
        {
          ...result,
          last_updated: lastUpdated,
        },
        3600,
      ); // Cache for 1 hour
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

// Top Performing Items
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

    // Parse branch filter
    let branchFilter = {};
    if (branchIds) {
      const branchArray = branchIds.split(",").map((id) => parseInt(id));
      if (branchArray.length > 0) {
        branchFilter.branch_id = { [Op.in]: branchArray };
      }
    }

    // Date filter
    const dateFilter = {};
    if (startDate && endDate) {
      dateFilter.createdAt = { [Op.between]: [startDate, endDate] };
    }

    const combinedFilter = { ...dateFilter, ...branchFilter };

    // Get top items (always sort by revenue in SQL since profit is calculated later)
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
      GROUP BY ii.id, ii.item_name, ii.fabric_type, it.fabric_type
      ORDER BY revenue DESC
      LIMIT :limit
    `,
      {
        replacements: {
          startDate: dateFilter.createdAt?.[Op.between]?.[0] || new Date(0),
          endDate: dateFilter.createdAt?.[Op.between]?.[1] || new Date(),
          branchIds: branchFilter.branch_id?.[Op.in] || [],
          limit: parseInt(limit) * 2, // Get more items since we'll re-sort after profit calculation
        },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Optimize: Fetch all item details in one query instead of N+1
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
      attributes: ["total_price", "weight", "inventory_item_id"],
    });

    // Group item details by inventory_item_id
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

    // Group inventory items by id for quick lookup
    const inventoryItemsById = {};
    allItemDetails.forEach((detail) => {
      if (detail.inventory_item) {
        inventoryItemsById[detail.inventory_item.id] = detail.inventory_item;
      }
    });

    // Calculate profit for each item
    const itemsWithProfit = topItems.map((item) => {
      const itemDetails = detailsByItemId[item.id] || [];
      const inventoryItem = inventoryItemsById[item.id];

      let cost = 0;
      // For Watch and Diamond, use cost_per_meter as total (not per gram * weight)
      if (
        inventoryItem?.fabric_type === "Watch" ||
        inventoryItem?.fabric_type === "Diamond"
      ) {
        cost =
          parseFloat(inventoryItem?.cost_per_meter || 0) *
          itemDetails.length;
      } else {
        // For Gold/Silver/Platinum, use cost_per_meter * weight
        itemDetails.forEach((detail) => {
          const buyPrice = parseFloat(
            detail.inventory_item?.cost_per_meter || 0,
          );
          const weight = parseFloat(detail.meters || 0) * (parseInt(detail.quantity, 10) || 1);
          cost += buyPrice * weight;
        });
      }

      return {
        id: item.id,
        name: item.name,
        category: item.category,
        fabric_type: item.fabric_type || null,
        revenue: parseFloat(item.revenue) || 0,
        profit: (parseFloat(item.revenue) || 0) - cost,
        quantity: parseInt(item.quantity) || 0,
        weight: parseFloat(item.meters) || 0,
      };
    });

    // Re-sort based on selected metric and return only requested limit
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
