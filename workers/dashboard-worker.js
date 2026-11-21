import "../src/config/env.js";
import sequelize from "../src/config/database.js";
import { cacheSet, isRedisAvailable, ensureRedisConnected } from "../src/config/redis.js";
import logger from "../src/utils/logger.js";
import cron from "node-cron";
import "../src/domains/associations.js";
import Tenant from "../src/domains/platform/tenant.model.js";
import Invoice from "../src/domains/sales/invoice.model.js";
import InventoryItem from "../src/domains/inventory/item.model.js";
import User from "../src/domains/auth/user.model.js";
import Branch from "../src/domains/store/branch.model.js";
import Customer from "../src/domains/customers/customer.model.js";
import WhatsappConfig from "../src/domains/platform/whatsapp.config.model.js";
import { Op, Sequelize } from "sequelize";
import {
  startOfKuwaitDay,
  daysAgoKuwaitStart,
} from "../src/utils/kuwaitTime.js";

const CACHE_TTL = {
  TODAY: 3600,
  WEEKLY: 86400,
  MONTHLY: 86400 * 7,
  LOW_STOCK: 3600,
};

const aggregateOwnerDashboard = async (tenant) => {
  try {
    const schema = tenant.db_schema;
    const todayStart = startOfKuwaitDay(new Date());
    const weekStart = daysAgoKuwaitStart(7);
    const monthStart = daysAgoKuwaitStart(30);

    const [
      [periodTotals = {}],
      [periodCost = {}],
      [inventoryTotals = {}],
      activeBranches,
      whatsappConfig,
      salesTrend7Days,
      salesTrend30Days,
      branchSales,
      categoryFabricSales,
      fabricSales,
      topItemsRevenue,
      topCustomers,
      lowStockItems,
    ] = await Promise.all([
      sequelize.query(
        `
        SELECT
          COALESCE(SUM(inv.total_amount), 0) AS total_sales,
          COALESCE(SUM(inv.total_meters), 0) AS total_meters,
          COUNT(*)::int AS invoice_count
        FROM "${schema}".invoices inv
        WHERE inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT
          COALESCE(SUM(
            COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
          ), 0) AS total_cost
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        WHERE inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT
          COALESCE(SUM(
            COALESCE(length_m, 0) * COALESCE(cost_per_meter, 0) * COALESCE(quantity, 1)
          ), 0) AS total_inventory_value
        FROM "${schema}".inventory_items
        WHERE status = 'In Stock'
        `,
        {
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      Branch.schema(schema).count(),
      WhatsappConfig.findOne({
        where: { tenant_slug: tenant.slug },
      }),
      Invoice.schema(schema).findAll({
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
      }),
      Invoice.schema(schema).findAll({
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
      }),
      Invoice.schema(schema).findAll({
        where: {
          createdAt: { [Op.gte]: todayStart },
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
      }),
      sequelize.query(
        `
        SELECT
          CONCAT(it.fabric_type, ' · ', COALESCE(ii.pattern, '')) AS name,
          ii.pattern,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          SUM(COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS cost,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY it.fabric_type, ii.pattern
        ORDER BY revenue DESC
      `,
        {
          replacements: { todayStart },
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
        WHERE inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY it.fabric_type
        ORDER BY it.fabric_type ASC
      `,
        {
          replacements: { todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT
          ii.id,
          ii.item_name AS name,
          ii.pattern,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          SUM(COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS cost,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY ii.id, ii.item_name, ii.pattern, it.fabric_type
        ORDER BY revenue DESC
        LIMIT 5
      `,
        {
          replacements: { todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      Invoice.schema(schema).findAll({
        where: {
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
      InventoryItem.schema(schema).findAll({
        where: {
          status: "In Stock",
          quantity: { [Op.lte]: Sequelize.col("min_stock_level") },
        },
        attributes: [
          "id",
          "item_name",
          "pattern",
          "quantity",
          "min_stock_level",
        ],
        limit: 20,
      }),
    ]);

    const totalSalesToday = parseFloat(periodTotals.total_sales || 0);
    const totalMetersToday = parseFloat(periodTotals.total_meters || 0);
    const invoiceCountToday = parseInt(periodTotals.invoice_count || 0, 10);
    const totalCostToday = parseFloat(periodCost.total_cost || 0);
    const netProfitToday = totalSalesToday - totalCostToday;
    const avgSaleValue =
      invoiceCountToday > 0 ? totalSalesToday / invoiceCountToday : 0;
    const totalInventoryValue = parseFloat(
      inventoryTotals.total_inventory_value || 0,
    );

    const categoryFabricWithProfit = categoryFabricSales.map((item) => ({
      name: item.name,
      pattern: item.pattern,
      fabric_type: item.fabric_type,
      revenue: parseFloat(item.revenue || 0),
      profit: parseFloat(item.revenue || 0) - parseFloat(item.cost || 0),
      quantity: parseInt(item.quantity || 0, 10),
    }));

    const topItemsWithProfit = topItemsRevenue.map((item) => ({
      id: item.id,
      name: item.name,
      pattern: item.pattern,
      fabric_type: item.fabric_type,
      revenue: parseFloat(item.revenue || 0),
      profit: parseFloat(item.revenue || 0) - parseFloat(item.cost || 0),
      quantity: parseInt(item.quantity || 0, 10),
    }));

    const dashboardData = {
      kpi: {
        total_sales: totalSalesToday.toFixed(3),
        net_profit: netProfitToday.toFixed(3),
        total_meters: totalMetersToday.toFixed(3),
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
        sales_by_category_fabric: categoryFabricWithProfit,
        sales_by_fabric: fabricSales.map((k) => ({
          fabric_type: k.fabric_type,
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
          pattern: i.pattern,
          quantity: i.quantity,
          min_stock_level: i.min_stock_level,
        })),
      },
      last_updated: new Date().toISOString(),
    };

    const cacheKey = `dashboard:owner:${tenant.slug}`;
    const cacheKeyToday = `dashboard:owner:${tenant.slug}:today:today`;
    await cacheSet(cacheKey, dashboardData, CACHE_TTL.TODAY);
    await cacheSet(cacheKeyToday, dashboardData, CACHE_TTL.TODAY);

    logger.info("Owner dashboard aggregated", {
      component: "worker",
      tenant: tenant.slug,
      cacheKey: cacheKeyToday,
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

const aggregateManagerDashboard = async (tenant, branchId) => {
  try {
    const schema = tenant.db_schema;
    const todayStart = startOfKuwaitDay(new Date());
    const weekStart = daysAgoKuwaitStart(7);
    const monthStart = daysAgoKuwaitStart(30);

    const [
      [branchTotals = {}],
      [branchCost = {}],
      salesTrend7Days,
      salesTrend30Days,
      categoryFabricSales,
      fabricSales,
      staffPerformanceToday,
      staffPerformanceWeek,
      staffPerformanceMonth,
      topItemsRevenue,
      topCustomers,
      lowStockItems,
    ] = await Promise.all([
      sequelize.query(
        `
        SELECT
          COALESCE(SUM(inv.total_amount), 0) AS total_sales,
          COALESCE(SUM(inv.total_meters), 0) AS total_meters,
          COUNT(*)::int AS invoice_count
        FROM "${schema}".invoices inv
        WHERE inv.branch_id = :branchId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { branchId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT
          COALESCE(SUM(
            COALESCE(it.cost_per_meter_snapshot, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
          ), 0) AS total_cost
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        WHERE inv.branch_id = :branchId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { branchId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
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
          CONCAT(it.fabric_type, ' · ', COALESCE(ii.pattern, '')) AS name,
          ii.pattern,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.branch_id = :branchId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY it.fabric_type, ii.pattern
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
        WHERE inv.branch_id = :branchId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
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
      }),
      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.gte]: weekStart },
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
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
      }),
      Invoice.schema(schema).findAll({
        where: {
          branch_id: branchId,
          createdAt: { [Op.gte]: monthStart },
          status: { [Op.in]: ["Paid", "Partially Refunded"] },
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
      }),
      sequelize.query(
        `
        SELECT
          ii.id,
          ii.item_name AS name,
          ii.pattern,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.branch_id = :branchId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY ii.id, ii.item_name, ii.pattern, it.fabric_type
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
      InventoryItem.schema(schema).findAll({
        where: {
          branch_id: branchId,
          status: "In Stock",
          quantity: { [Op.lte]: Sequelize.col("min_stock_level") },
        },
        attributes: [
          "id",
          "item_name",
          "pattern",
          "quantity",
          "min_stock_level",
        ],
        limit: 20,
      }),
    ]);

    const branchSalesToday = parseFloat(branchTotals.total_sales || 0);
    const totalMetersToday = parseFloat(branchTotals.total_meters || 0);
    const invoiceCountToday = parseInt(branchTotals.invoice_count || 0, 10);
    const totalCostToday = parseFloat(branchCost.total_cost || 0);
    const netProfitToday = branchSalesToday - totalCostToday;
    const avgSaleValue =
      invoiceCountToday > 0 ? branchSalesToday / invoiceCountToday : 0;

    const dashboardData = {
      kpi: {
        branch_sales: branchSalesToday.toFixed(3),
        net_profit: netProfitToday.toFixed(3),
        total_meters: totalMetersToday.toFixed(3),
        invoice_count: invoiceCountToday,
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
        sales_by_category_fabric: categoryFabricSales.map((c) => ({
          name: c.name,
          revenue: parseFloat(c.revenue || 0),
          quantity: parseInt(c.quantity || 0),
        })),
        sales_by_fabric: fabricSales.map((k) => ({
          fabric_type: k.fabric_type,
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
          pattern: i.pattern,
          fabric_type: i.fabric_type,
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
          pattern: i.pattern,
          quantity: i.quantity,
          min_stock_level: i.min_stock_level,
        })),
      },
      last_updated: new Date().toISOString(),
    };

    const cacheKey = `dashboard:manager:${tenant.slug}:${branchId}`;
    const cacheKeyToday = `dashboard:manager:${tenant.slug}:${branchId}:today:today`;
    await cacheSet(cacheKey, dashboardData, CACHE_TTL.TODAY);
    await cacheSet(cacheKeyToday, dashboardData, CACHE_TTL.TODAY);

    logger.info("Manager dashboard aggregated", {
      component: "worker",
      tenant: tenant.slug,
      branchId,
      cacheKey: cacheKeyToday,
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

const aggregateSalesmanDashboard = async (tenant, userId) => {
  try {
    const schema = tenant.db_schema;
    const todayStart = startOfKuwaitDay(new Date());
    const weekStart = daysAgoKuwaitStart(7);

    const [
      [myTotals = {}],
      [itemsTotals = {}],
      salesTrend7Days,
      categoryFabricSales,
      fabricSales,
      topItems,
    ] = await Promise.all([
      sequelize.query(
        `
        SELECT
          COALESCE(SUM(inv.total_amount), 0) AS my_sales_today,
          COALESCE(SUM(inv.total_meters), 0) AS my_meters_today,
          COUNT(*)::int AS invoice_count
        FROM "${schema}".invoices inv
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { userId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT COUNT(*)::int AS items_sold
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { userId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      Invoice.schema(schema).findAll({
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
      }),
      sequelize.query(
        `
        SELECT
          CONCAT(it.fabric_type, ' · ', COALESCE(ii.pattern, '')) AS name,
          ii.pattern,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY it.fabric_type, ii.pattern
        ORDER BY revenue DESC
      `,
        {
          replacements: { userId, todayStart },
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
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY it.fabric_type
        ORDER BY it.fabric_type ASC
      `,
        {
          replacements: { userId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT
          ii.id,
          ii.item_name AS name,
          ii.pattern,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY ii.id, ii.item_name, ii.pattern, it.fabric_type
        ORDER BY revenue DESC
        LIMIT 5
      `,
        {
          replacements: { userId, todayStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
    ]);

    const mySalesToday = parseFloat(myTotals.my_sales_today || 0);
    const myMetersToday = parseFloat(myTotals.my_meters_today || 0);
    const myInvoiceCount = parseInt(myTotals.invoice_count || 0, 10);
    const itemsSoldCount = parseInt(itemsTotals.items_sold || 0, 10);
    const avgSaleValue =
      myInvoiceCount > 0 ? mySalesToday / myInvoiceCount : 0;

    const dashboardData = {
      kpi: {
        my_sales_today: mySalesToday.toFixed(3),
        my_meters_today: myMetersToday.toFixed(2),
        invoice_count: myInvoiceCount,
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
          fabric_type: k.fabric_type,
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        top_5_items: topItems.map((i) => ({
          id: i.id,
          name: i.name,
          pattern: i.pattern,
          fabric_type: i.fabric_type,
          revenue: parseFloat(i.revenue || 0),
          quantity: parseInt(i.quantity || 0),
        })),
      },
      last_updated: new Date().toISOString(),
    };

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

        await aggregateOwnerDashboard(tenant);

        const branches = await Branch.schema(tenant.db_schema).findAll();

        for (const branch of branches) {
          await aggregateManagerDashboard(tenant, branch.id);
        }

        const salesmen = await User.schema(tenant.db_schema).findAll({
          where: { role: "sales_man" },
        });

        for (const salesman of salesmen) {
          await aggregateSalesmanDashboard(tenant, salesman.id);
        }
      } catch (error) {
        logger.error("Tenant processing error", {
          component: "worker",
          tenant: tenant.slug,
          error: error?.message,
        });

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

const main = async () => {
  try {
    logger.info("Dashboard Worker starting", { component: "worker" });

    await sequelize.authenticate();
    logger.info("Database connected", { component: "worker" });

    await ensureRedisConnected(2000);
    if (isRedisAvailable()) {
      logger.info("Redis available, caching enabled", { component: "worker" });
    } else {
      logger.debug("Redis not available, will use database fallback", {
        component: "worker",
      });
    }

    await processAllTenants();

    cron.schedule("0 2 * * *", async () => {
      logger.info("Running nightly aggregation", { component: "worker" });
      await processAllTenants();
    });

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

main();
