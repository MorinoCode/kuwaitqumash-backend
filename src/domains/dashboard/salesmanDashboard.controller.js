import sequelize from "../../config/database.js";
import logger from "../../utils/logger.js";
import { cacheGet, cacheSet } from "../../config/redis.js";
import {
  startOfKuwaitDay,
  endOfKuwaitDay,
  daysAgoKuwaitStart,
} from "../../utils/kuwaitTime.js";

const DASHBOARD_CACHE_TTL_SECONDS = Number(process.env.DASHBOARD_CACHE_TTL_SECONDS) || 300;

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

    // Run all 9 independent salesman dashboard queries in parallel inside PostgreSQL.
    const [
      [myTotals = {}],
      [myRefunds = {}],
      [itemsTotals = {}],
      salesTrend7Days,
      categoryFabricSales,
      fabricSales,
      topItems,
      recentInvoices,
      branchRemnants,
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
          AND inv.created_at <= :todayEnd
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { userId, todayStart, todayEnd },
          type: sequelize.QueryTypes.SELECT,
        },
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
            WHERE inv2.created_by = :userId
              AND inv2.created_at >= :todayStart
              AND inv2.created_at <= :todayEnd
              AND inv2.status = 'Partially Refunded'
              AND r2.status = 'Completed'
          ), 0) AS refunded_meters
        FROM "${schema}".refunds r
        INNER JOIN "${schema}".invoices inv ON r.invoice_id = inv.id
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.created_at <= :todayEnd
          AND inv.status = 'Partially Refunded'
          AND r.status = 'Completed'
        `,
        {
          replacements: { userId, todayStart, todayEnd },
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
          AND inv.created_at <= :todayEnd
          AND inv.status IN ('Paid', 'Partially Refunded')
        `,
        {
          replacements: { userId, todayStart, todayEnd },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT
          TO_CHAR((inv.created_at AT TIME ZONE 'Asia/Kuwait')::date, 'YYYY-MM-DD') AS date,
          COALESCE(SUM(inv.total_amount), 0) AS revenue
        FROM "${schema}".invoices inv
        WHERE inv.created_by = :userId
          AND inv.created_at >= :weekStart
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY (inv.created_at AT TIME ZONE 'Asia/Kuwait')::date
        ORDER BY (inv.created_at AT TIME ZONE 'Asia/Kuwait')::date ASC
        `,
        {
          replacements: { userId, weekStart },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT
          CONCAT(it.fabric_type, ' · ', COALESCE(it.color, '')) AS name,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.created_at <= :todayEnd
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY it.fabric_type, it.color
        ORDER BY revenue DESC
        `,
        {
          replacements: { userId, todayStart, todayEnd },
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
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.created_at <= :todayEnd
          AND inv.status IN ('Paid', 'Partially Refunded')
          AND it.fabric_type IS NOT NULL
        GROUP BY it.fabric_type
        ORDER BY it.fabric_type ASC
        `,
        {
          replacements: { userId, todayStart, todayEnd },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize.query(
        `
        SELECT
          ii.id,
          COALESCE(NULLIF(ii.item_name, ''), CONCAT(ii.fabric_type, ' ', COALESCE(ii.color, ''))) AS name,
          ii.fabric_type,
          it.fabric_type,
          SUM(it.total_price) AS revenue,
          SUM(COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS meters,
          COUNT(it.id) AS quantity
        FROM "${schema}".invoice_items it
        INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
        INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
        WHERE inv.created_by = :userId
          AND inv.created_at >= :todayStart
          AND inv.created_at <= :todayEnd
          AND inv.status IN ('Paid', 'Partially Refunded')
        GROUP BY ii.id, ii.item_name, it.fabric_type, it.color, ii.fabric_type, ii.color
        ORDER BY revenue DESC
        LIMIT 5
        `,
        {
          replacements: { userId, todayStart, todayEnd },
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      sequelize
        .query(
          `
          SELECT
            inv.id,
            inv.invoice_number,
            COALESCE(c.full_name, 'Walk-in') AS customer_name,
            inv.total_meters,
            inv.total_amount,
            inv.status,
            inv.created_at
          FROM "${schema}".invoices inv
          LEFT JOIN "${schema}".customers c ON c.id = inv.customer_id
          WHERE inv.created_by = :userId
            AND inv.status IN ('Paid', 'Partially Refunded')
          ORDER BY inv.created_at DESC
          LIMIT 8
          `,
          {
            replacements: { userId },
            type: sequelize.QueryTypes.SELECT,
          },
        )
        .catch(() => []),
      req.user.branch_id
        ? sequelize
            .query(
              `
              SELECT
                ii.id,
                COALESCE(NULLIF(ii.item_name, ''), CONCAT(ii.fabric_type, ' ', COALESCE(ii.color, ''))) AS name,
                ii.fabric_type,
                ii.pattern,
                ii.color,
                (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) AS stock_meters,
                COALESCE(ii.price_per_meter, 0) AS price_per_meter
              FROM "${schema}".inventory_items ii
              WHERE ii.branch_id = :branchId
                AND ii.status = 'In Stock'
                AND (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) > 0
                AND (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) <= 3.5
              ORDER BY stock_meters ASC
              LIMIT 10
              `,
              {
                replacements: { branchId: req.user.branch_id },
                type: sequelize.QueryTypes.SELECT,
              },
            )
            .catch(() => [])
        : Promise.resolve([]),
    ]);

    const mySalesToday = Math.max(
      0,
      parseFloat(myTotals.my_sales_today || 0) - parseFloat(myRefunds.refunded_amount || 0),
    );
    const myMetersToday = Math.max(
      0,
      parseFloat(myTotals.my_meters_today || 0) - parseFloat(myRefunds.refunded_meters || 0),
    );
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
          fabric_type: k.fabric_type || null,
          revenue: parseFloat(k.revenue || 0),
          quantity: parseInt(k.quantity || 0),
        })),
        top_5_items: topItems.map((i) => ({
          id: i.id,
          name: i.name,
          fabric_type: i.fabric_type || null,
          revenue: parseFloat(i.revenue || 0),
          meters: parseFloat(i.meters || 0),
          quantity: parseInt(i.quantity || 0),
        })),
        recent_invoices: recentInvoices.map((inv) => ({
          id: inv.id,
          invoice_number: inv.invoice_number,
          customer_name: inv.customer_name,
          total_meters: parseFloat(inv.total_meters || 0),
          total_amount: parseFloat(inv.total_amount || 0),
          status: inv.status,
          created_at: inv.created_at,
        })),
        branch_remnants: branchRemnants.map((r) => ({
          id: r.id,
          name: r.name,
          fabric_type: r.fabric_type || "-",
          pattern: r.pattern || "-",
          color: r.color || "-",
          stock_meters: parseFloat(r.stock_meters || 0),
          price_per_meter: parseFloat(r.price_per_meter || 0),
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
