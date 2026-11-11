/**
 * Dashboard Worker - Separate process for dashboard data aggregation
 * Runs nightly/hourly aggregations and caches data in Redis
 * Can be deployed separately on Google Cloud
 */
import "../src/config/env.js";
import sequelize from "../src/config/database.js";
import { cacheSet, isRedisAvailable } from "../src/config/redis.js";
import logger from "../src/utils/logger.js";
import cron from "node-cron";
import Tenant from "../src/domains/platform/tenant.model.js";
import Invoice from "../src/domains/sales/invoice.model.js";
import InvoiceItem from "../src/domains/sales/invoice-item.model.js";
import InventoryItem from "../src/domains/inventory/item.model.js";
import User from "../src/domains/auth/user.model.js";
import Branch from "../src/domains/store/branch.model.js";
import Customer from "../src/domains/customers/customer.model.js";
import WhatsappConfig from "../src/domains/platform/whatsapp.config.model.js";
import { Op, Sequelize } from "sequelize";


const CACHE_TTL = {
  TODAY: 3600, // 1 hour for today's data
  WEEKLY: 86400, // 24 hours for weekly data
  MONTHLY: 86400 * 7, // 7 days for monthly data
  LOW_STOCK: 3600, // 1 hour for low stock alerts
};

/**
 * Calculate profit using cost_per_meter_snapshot from invoice items
 */
const calculateProfit = (items) => {
  let totalCost = 0;
  items.forEach((item) => {
    const meters = parseFloat(item.meters || 0);
    const buyPrice = parseFloat(item.cost_per_meter_snapshot || 0);
    totalCost += meters * buyPrice;
  });
  return totalCost;
};

/**
 * Combine category + fabric_type for analytics (e.g., "انگشتر ۱۸ عیار")
 */


/**
 * Aggregate Owner Dashboard Data
 */
const aggregateOwnerDashboard = async (tenant) => {
  try {
    const schema = tenant.db_schema;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const monthStart = new Date();
    monthStart.setDate(monthStart.getDate() - 30);

    // Today's KPIs
    const invoicesToday = await Invoice.schema(schema).findAll({
      where: {
        createdAt: { [Op.gte]: todayStart },
        status: "Paid",
      },
      include: [{ model: InvoiceItem.schema(schema), as: "items" }],
    });

    let totalSalesToday = 0;
    let totalWeightToday = 0;
    let totalCostToday = 0;

    invoicesToday.forEach((inv) => {
      totalSalesToday += parseFloat(inv.total_amount || 0);
      totalWeightToday += parseFloat(inv.total_meters || 0);
      inv.items.forEach((item) => {
        const meters = parseFloat(item.meters || 0);
        const buyPrice = parseFloat(item.cost_per_meter_snapshot || 0);
        totalCostToday += meters * buyPrice;
      });
    });

    const netProfitToday = totalSalesToday - totalCostToday;
    const avgSaleValue =
      invoicesToday.length > 0 ? totalSalesToday / invoicesToday.length : 0;

    // Total Inventory Value
    const inventoryItems = await InventoryItem.schema(schema).findAll({
      where: { status: "In Stock" },
      attributes: ["meters", "cost_per_meter", "quantity"],
    });

    let totalInventoryValue = 0;
    inventoryItems.forEach((item) => {
      const value =
        parseFloat(item.meters || 0) *
        parseFloat(item.cost_per_meter || 0) *
        parseInt(item.quantity || 1);
      totalInventoryValue += value;
    });

    // Active Branches Count
    const activeBranches = await Branch.schema(schema).count({
      where: { is_active: true },
    });

    // WhatsApp Status
    const whatsappConfig = await WhatsappConfig.findOne({
      where: { tenant_slug: tenant.slug },
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
        createdAt: { [Op.gte]: todayStart },
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
    const categoryKaratSales = await sequelize.query(
      `
      SELECT 
        CONCAT(ii.category, ' ', it.fabric_type, 'K') AS name,
        ii.category,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY ii.category, it.fabric_type
      ORDER BY revenue DESC
    `,
      {
        replacements: { todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Calculate profit for category+fabric_type
    const categoryKaratWithProfit = await Promise.all(
      categoryKaratSales.map(async (item) => {
        const items = await InvoiceItem.schema(schema).findAll({
          include: [
            {
              model: Invoice.schema(schema),
              where: {
                createdAt: { [Op.gte]: todayStart },
                status: "Paid",
              },
              attributes: [],
            },
            {
              model: InventoryItem.schema(schema),
              as: "inventory_item",
              where: { category: item.category },
              attributes: [],
            },
          ],
          where: { fabric_type: item.fabric_type.replace("K", "") },
          attributes: ["meters", "cost_per_meter_snapshot"],
        });

        const cost = calculateProfit(items);
        return {
          name: item.name,
          category: item.category,
          fabric_type: item.fabric_type,
          revenue: parseFloat(item.revenue || 0),
          profit: parseFloat(item.revenue || 0) - cost,
          quantity: parseInt(item.quantity || 0),
        };
      }),
    );

    // Sales by Karat
    const karatSales = await sequelize.query(
      `
      SELECT 
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY it.fabric_type
      ORDER BY it.fabric_type DESC
    `,
      {
        replacements: { todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Top 5 Selling Items (by Revenue)
    const topItemsRevenue = await sequelize.query(
      `
      SELECT 
        ii.id,
        ii.item_name AS name,
        ii.category,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY ii.id, ii.item_name, ii.category, it.fabric_type
      ORDER BY revenue DESC
      LIMIT 5
    `,
      {
        replacements: { todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Calculate profit for top items
    const topItemsWithProfit = await Promise.all(
      topItemsRevenue.map(async (item) => {
        const items = await InvoiceItem.schema(schema).findAll({
          include: [
            {
              model: Invoice.schema(schema),
              where: {
                createdAt: { [Op.gte]: todayStart },
                status: "Paid",
              },
              attributes: [],
            },
          ],
          where: { inventory_item_id: item.id },
          attributes: ["meters", "cost_per_meter_snapshot"],
        });

        const cost = calculateProfit(items);
        return {
          id: item.id,
          name: item.name,
          category: item.category,
          fabric_type: item.fabric_type + "K",
          revenue: parseFloat(item.revenue || 0),
          profit: parseFloat(item.revenue || 0) - cost,
          quantity: parseInt(item.quantity || 0),
        };
      }),
    );

    // Top 5 Customers (by value)
    const topCustomers = await Invoice.schema(schema).findAll({
      where: {
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
        total_meters: totalWeightToday.toFixed(3),
        avg_sale_value: avgSaleValue.toFixed(3),
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
          fabric_type: k.fabric_type + "K",
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        top_5_items_revenue: topItemsWithProfit,
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

    // Cache in Redis
    const cacheKey = `dashboard:owner:${tenant.slug}`;
    await cacheSet(cacheKey, dashboardData, CACHE_TTL.TODAY);

    logger.info("Owner dashboard aggregated", {
      component: "worker",
      tenant: tenant.slug,
      cacheKey,
    });

    return dashboardData;
  } catch (error) {
    logger.error("Owner dashboard aggregation error", {
      component: "worker",
      tenant: tenant.slug,
      error: error?.message,
      stack: error?.stack,
    });
    throw error;
  }
};

/**
 * Aggregate Manager Dashboard Data
 */
const aggregateManagerDashboard = async (tenant, branchId) => {
  try {
    const schema = tenant.db_schema;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    const monthStart = new Date();
    monthStart.setDate(monthStart.getDate() - 30);

    // Today's KPIs
    const invoicesToday = await Invoice.schema(schema).findAll({
      where: {
        branch_id: branchId,
        createdAt: { [Op.gte]: todayStart },
        status: "Paid",
      },
      include: [{ model: InvoiceItem.schema(schema), as: "items" }],
    });

    let branchSalesToday = 0;
    let totalWeightToday = 0;
    let totalCostToday = 0;

    invoicesToday.forEach((inv) => {
      branchSalesToday += parseFloat(inv.total_amount || 0);
      totalWeightToday += parseFloat(inv.total_meters || 0);
      inv.items.forEach((item) => {
        const meters = parseFloat(item.meters || 0);
        const buyPrice = parseFloat(item.cost_per_meter_snapshot || 0);
        totalCostToday += meters * buyPrice;
      });
    });

    const netProfitToday = branchSalesToday - totalCostToday;
    const avgSaleValue =
      invoicesToday.length > 0 ? branchSalesToday / invoicesToday.length : 0;

    // Sales Trend (7/30 days)
    const salesTrend7Days = await Invoice.schema(schema).findAll({
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
    });

    const salesTrend30Days = await Invoice.schema(schema).findAll({
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
    });

    // Sales by Category + Karat
    const categoryKaratSales = await sequelize.query(
      `
      SELECT 
        CONCAT(ii.category, ' ', it.fabric_type, 'K') AS name,
        ii.category,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.branch_id = :branchId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY ii.category, it.fabric_type
      ORDER BY revenue DESC
    `,
      {
        replacements: { branchId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Sales by Karat
    const karatSales = await sequelize.query(
      `
      SELECT 
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.branch_id = :branchId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY it.fabric_type
      ORDER BY it.fabric_type DESC
    `,
      {
        replacements: { branchId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Staff Performance (Today/Week/Month)
    const staffPerformanceToday = await Invoice.schema(schema).findAll({
      where: {
        branch_id: branchId,
        createdAt: { [Op.gte]: todayStart },
        status: "Paid",
      },
      attributes: [
        "created_by",
        [Sequelize.fn("sum", Sequelize.col("total_amount")), "total_sales"],
        [Sequelize.fn("count", Sequelize.col("id")), "invoice_count"],
      ],
      include: [
        {
          model: User.schema(schema),
          as: "creator",
          attributes: ["full_name"],
        },
      ],
      group: ["created_by", "creator.id", "creator.full_name"],
      order: [[Sequelize.fn("sum", Sequelize.col("total_amount")), "DESC"]],
      raw: true,
      nest: true,
    });

    const staffPerformanceWeek = await Invoice.schema(schema).findAll({
      where: {
        branch_id: branchId,
        createdAt: { [Op.gte]: weekStart },
        status: "Paid",
      },
      attributes: [
        "created_by",
        [Sequelize.fn("sum", Sequelize.col("total_amount")), "total_sales"],
        [Sequelize.fn("count", Sequelize.col("id")), "invoice_count"],
      ],
      include: [
        {
          model: User.schema(schema),
          as: "creator",
          attributes: ["full_name"],
        },
      ],
      group: ["created_by", "creator.id", "creator.full_name"],
      order: [[Sequelize.fn("sum", Sequelize.col("total_amount")), "DESC"]],
      raw: true,
      nest: true,
    });

    const staffPerformanceMonth = await Invoice.schema(schema).findAll({
      where: {
        branch_id: branchId,
        createdAt: { [Op.gte]: monthStart },
        status: "Paid",
      },
      attributes: [
        "created_by",
        [Sequelize.fn("sum", Sequelize.col("total_amount")), "total_sales"],
        [Sequelize.fn("count", Sequelize.col("id")), "invoice_count"],
      ],
      include: [
        {
          model: User.schema(schema),
          as: "creator",
          attributes: ["full_name"],
        },
      ],
      group: ["created_by", "creator.id", "creator.full_name"],
      order: [[Sequelize.fn("sum", Sequelize.col("total_amount")), "DESC"]],
      raw: true,
      nest: true,
    });

    // Top 5 Items (by Revenue)
    const topItemsRevenue = await sequelize.query(
      `
      SELECT 
        ii.id,
        ii.item_name AS name,
        ii.category,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.branch_id = :branchId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY ii.id, ii.item_name, ii.category, it.fabric_type
      ORDER BY revenue DESC
      LIMIT 5
    `,
      {
        replacements: { branchId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Top 5 Customers
    const topCustomers = await Invoice.schema(schema).findAll({
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
    });

    // Low Stock Items
    const lowStockItems = await InventoryItem.schema(schema).findAll({
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
    });

    const dashboardData = {
      kpi: {
        branch_sales: branchSalesToday.toFixed(3),
        net_profit: netProfitToday.toFixed(3),
        total_meters: totalWeightToday.toFixed(3),
        invoice_count: invoicesToday.length,
        avg_sale_value: avgSaleValue.toFixed(3),
        low_stock_count: lowStockItems.length,
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
        sales_by_category_karat: categoryKaratSales.map((c) => ({
          name: c.name,
          revenue: parseFloat(c.revenue || 0),
          quantity: parseInt(c.quantity || 0),
        })),
        sales_by_karat: karatSales.map((k) => ({
          fabric_type: k.fabric_type + "K",
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        staff_performance_today: staffPerformanceToday.map((s) => ({
          name: s.creator?.full_name || "Unknown",
          sales: parseFloat(s.total_sales || 0),
          invoices: parseInt(s.invoice_count || 0),
        })),
        staff_performance_week: staffPerformanceWeek.map((s) => ({
          name: s.creator?.full_name || "Unknown",
          sales: parseFloat(s.total_sales || 0),
          invoices: parseInt(s.invoice_count || 0),
        })),
        staff_performance_month: staffPerformanceMonth.map((s) => ({
          name: s.creator?.full_name || "Unknown",
          sales: parseFloat(s.total_sales || 0),
          invoices: parseInt(s.invoice_count || 0),
        })),
        top_5_items_revenue: topItemsRevenue.map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          fabric_type: i.fabric_type + "K",
          revenue: parseFloat(i.revenue || 0),
          quantity: parseInt(i.quantity || 0),
        })),
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

    // Cache in Redis
    const cacheKey = `dashboard:manager:${tenant.slug}:${branchId}`;
    await cacheSet(cacheKey, dashboardData, CACHE_TTL.TODAY);

    logger.info("Manager dashboard aggregated", {
      component: "worker",
      tenant: tenant.slug,
      branchId,
      cacheKey,
    });

    return dashboardData;
  } catch (error) {
    logger.error("Manager dashboard aggregation error", {
      component: "worker",
      tenant: tenant.slug,
      branchId,
      error: error?.message,
      stack: error?.stack,
    });
    throw error;
  }
};

/**
 * Aggregate Salesman Dashboard Data
 */
const aggregateSalesmanDashboard = async (tenant, userId) => {
  try {
    const schema = tenant.db_schema;
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 7);

    // Today's KPIs
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
        CONCAT(ii.category, ' ', it.fabric_type, 'K') AS name,
        ii.category,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY ii.category, it.fabric_type
      ORDER BY revenue DESC
    `,
      {
        replacements: { userId, todayStart },
        type: sequelize.QueryTypes.SELECT,
      },
    );

    // Sales by Karat
    const karatSales = await sequelize.query(
      `
      SELECT 
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
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
        ii.category,
        it.fabric_type,
        SUM(it.total_price) AS revenue,
        COUNT(it.id) AS quantity
      FROM "${schema}".invoice_items it
      INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
      INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
      WHERE inv.created_by = :userId AND inv.created_at >= :todayStart AND inv.status = 'Paid'
      GROUP BY ii.id, ii.item_name, ii.category, it.fabric_type
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
          fabric_type: k.fabric_type + "K",
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        top_5_items: topItems.map((i) => ({
          id: i.id,
          name: i.name,
          category: i.category,
          fabric_type: i.fabric_type + "K",
          revenue: parseFloat(i.revenue || 0),
          quantity: parseInt(i.quantity || 0),
        })),
      },
      last_updated: new Date().toISOString(),
    };

    // Cache in Redis
    const cacheKey = `dashboard:salesman:${tenant.slug}:${userId}`;
    await cacheSet(cacheKey, dashboardData, CACHE_TTL.TODAY);

    logger.info("Salesman dashboard aggregated", {
      component: "worker",
      tenant: tenant.slug,
      userId,
      cacheKey,
    });

    return dashboardData;
  } catch (error) {
    logger.error("Salesman dashboard aggregation error", {
      component: "worker",
      tenant: tenant.slug,
      userId,
      error: error?.message,
      stack: error?.stack,
    });
    throw error;
  }
};

/**
 * Process all tenants
 */
const processAllTenants = async () => {
  try {
    const tenants = await Tenant.findAll({
      where: { subscription_status: "active" },
    });

    logger.info("Processing all tenants", {
      component: "worker",
      tenantCount: tenants.length,
    });

    for (const tenant of tenants) {
      try {
        // Aggregate owner dashboard
        await aggregateOwnerDashboard(tenant);

        // Get all branches for this tenant
        const branches = await Branch.schema(tenant.db_schema).findAll({
          where: { is_active: true },
        });

        // Aggregate manager dashboards
        for (const branch of branches) {
          await aggregateManagerDashboard(tenant, branch.id);
        }

        // Get all salesmen for this tenant
        const salesmen = await User.schema(tenant.db_schema).findAll({
          where: { role: "sales_man" },
        });

        // Aggregate salesman dashboards
        for (const salesman of salesmen) {
          await aggregateSalesmanDashboard(tenant, salesman.id);
        }
      } catch (error) {
        logger.error("Tenant processing error", {
          component: "worker",
          tenant: tenant.slug,
          error: error?.message,
        });
        // Continue with next tenant
      }
    }

    logger.info("All tenants processed", { component: "worker" });
  } catch (error) {
    logger.error("Process all tenants error", {
      component: "worker",
      error: error?.message,
      stack: error?.stack,
    });
  }
};

/**
 * Main worker function
 */
const main = async () => {
  try {
    logger.info("Dashboard Worker starting", { component: "worker" });

    // Test database connection
    await sequelize.authenticate();
    logger.info("Database connected", { component: "worker" });

    // Check Redis availability
    if (isRedisAvailable()) {
      logger.info("Redis available, caching enabled", { component: "worker" });
    } else {
      logger.debug("Redis not available, will use database fallback", {
        component: "worker",
      });
    }

    // Run immediately on startup
    await processAllTenants();

    // Schedule nightly aggregation (runs at 2 AM)
    cron.schedule("0 2 * * *", async () => {
      logger.info("Running nightly aggregation", { component: "worker" });
      await processAllTenants();
    });

    // Schedule hourly aggregation for today's data (runs every hour)
    cron.schedule("0 * * * *", async () => {
      logger.info("Running hourly aggregation", { component: "worker" });
      await processAllTenants();
    });

    logger.info("Dashboard Worker scheduled", { component: "worker" });
    logger.info("Worker running...", { component: "worker" });
  } catch (error) {
    logger.error("Worker startup error", {
      component: "worker",
      error: error?.message,
      stack: error?.stack,
    });
    process.exit(1);
  }
};

// Handle graceful shutdown
process.on("SIGTERM", async () => {
  logger.info("SIGTERM received, shutting down gracefully", {
    component: "worker",
  });
  await sequelize.close();
  process.exit(0);
});

process.on("SIGINT", async () => {
  logger.info("SIGINT received, shutting down gracefully", {
    component: "worker",
  });
  await sequelize.close();
  process.exit(0);
});

// Start worker
main();
