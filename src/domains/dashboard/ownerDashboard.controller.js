import { Op, Sequelize } from "sequelize";
import sequelize from "../../config/database.js";
import Invoice from "../sales/invoice.model.js";
import InventoryItem from "../inventory/item.model.js";
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

    // Aggregations run in parallel inside PostgreSQL to avoid sequential
    // roundtrips and keep latency low even with large invoice tables.
    const [
      [periodTotals = {}],
      [periodRefunds = {}],
      [periodCost = {}],
      topFabricRows,
      [monthTotals = {}],
      [inventoryTotals = {}],
      activeBranches,
      whatsappConfig,
      salesTrend7Days,
      salesTrend30Days,
      branchSales,
      categoryFabricSales,
      fabricSales,
    ] = await Promise.all([
      sequelize.query(
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
      ),
      sequelize.query(
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
      ),
      sequelize.query(
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
      ),
      sequelize.query(
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
          replacements: {},
          type: sequelize.QueryTypes.SELECT,
        },
      ),
      Branch.schema(schema).count(),
      WhatsappConfig.findOne({
        where: { tenant_slug: req.tenant.slug },
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
      }),
      sequelize.query(
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
      ),
    ]);

    const totalSalesToday = Math.max(
      0,
      parseFloat(periodTotals.total_sales || 0) - parseFloat(periodRefunds.refunded_amount || 0),
    );
    const totalMetersToday = Math.max(
      0,
      parseFloat(periodTotals.total_meters || 0) - parseFloat(periodRefunds.refunded_meters || 0),
    );
    const invoiceCountToday = parseInt(periodTotals.invoice_count || 0, 10);
    const totalCostToday = Math.max(
      0,
      parseFloat(periodCost.total_cost || 0) - parseFloat(periodRefunds.refunded_cost || 0),
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

    const monthSales = parseFloat(monthTotals.month_sales || 0);
    const monthMeters = parseFloat(monthTotals.month_meters || 0);
    const monthInvoiceCount = parseInt(monthTotals.month_invoices || 0, 10);
    const totalInventoryValue = parseFloat(
      inventoryTotals.total_inventory_value || 0,
    );

    const categoryFabricWithProfit = categoryFabricSales.map((item) => ({
      name: item.name,
      fabric_type: item.fabric_type || null,
      revenue: parseFloat(item.revenue || 0),
      profit: parseFloat(item.revenue || 0) - parseFloat(item.cost || 0),
      quantity: parseInt(item.quantity || 0),
    }));

    const safeOwnerQuery = async (sql) => {
      try {
        return await sequelize.query(sql, {
          replacements: { dateStart: todayStart, dateEnd: todayEnd },
          type: sequelize.QueryTypes.SELECT,
        });
      } catch (err) {
        logger.warn("Owner dashboard extended query fallback", {
          component: "dashboard",
          error: err?.message,
        });
        return [];
      }
    };

    // Run top-items and extended owner queries in parallel with date-scoped refund subqueries.
    const [topItemsRevenue, paymentRows, staffRows, deadStockRows, remnantRows] =
      await Promise.all([
        sequelize.query(
          `
          SELECT
            ii.id,
            COALESCE(NULLIF(ii.item_name, ''), CONCAT(ii.fabric_type, ' ', COALESCE(ii.color, ''))) AS name,
            ii.pattern,
            ii.color,
            COALESCE(ii.fabric_type, it.fabric_type) AS fabric_type,
            (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) AS stock_meters,
            GREATEST(0, COALESCE(SUM(it.total_price), 0) - COALESCE(SUM(ref_item.refunded_amount), 0)) AS revenue,
            GREATEST(0, COALESCE(SUM(
              COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
            ), 0) - COALESCE(SUM(ref_item.refunded_cost), 0)) AS cost,
            GREATEST(0, COALESCE(SUM(COALESCE(it.quantity, 1)), 0) - COALESCE(SUM(ref_item.refunded_qty), 0))::int AS quantity,
            GREATEST(0, COALESCE(SUM(COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) - COALESCE(SUM(ref_item.refunded_meters), 0)) AS meters
          FROM "${schema}".invoice_items it
          INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
          INNER JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
          LEFT JOIN (
            SELECT
              ri.invoice_item_id,
              SUM(COALESCE(ri.amount_refunded, 0)) AS refunded_amount,
              SUM(COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1)) AS refunded_meters,
              SUM(COALESCE(ri.quantity_refunded, 1)) AS refunded_qty,
              SUM(COALESCE(it2.cost_per_meter_snapshot, ii2.cost_per_meter, 0) * COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1)) AS refunded_cost
            FROM "${schema}".refund_items ri
            INNER JOIN "${schema}".refunds r ON ri.refund_id = r.id
            INNER JOIN "${schema}".invoices inv_r ON r.invoice_id = inv_r.id
            LEFT JOIN "${schema}".invoice_items it2 ON ri.invoice_item_id = it2.id
            LEFT JOIN "${schema}".inventory_items ii2 ON ri.inventory_item_id = ii2.id
            WHERE r.status = 'Completed'
              AND inv_r.created_at >= :dateStart
              AND inv_r.created_at <= :dateEnd
              AND inv_r.status = 'Partially Refunded'
            GROUP BY ri.invoice_item_id
          ) ref_item ON ref_item.invoice_item_id = it.id
          WHERE inv.created_at >= :dateStart
            AND inv.created_at <= :dateEnd
            AND inv.status IN ('Paid', 'Partially Refunded')
          GROUP BY ii.id, ii.item_name, ii.pattern, ii.color, ii.length_m, ii.quantity, COALESCE(ii.fabric_type, it.fabric_type)
          ORDER BY revenue DESC
          LIMIT 10
        `,
          {
            replacements: { dateStart: todayStart, dateEnd: todayEnd },
            type: sequelize.QueryTypes.SELECT,
          },
        ),
        safeOwnerQuery(`
          SELECT
            ip.method,
            GREATEST(0, COALESCE(SUM(ip.amount), 0) - COALESCE(MAX(rp_agg.refunded_amount), 0)) AS amount,
            COUNT(DISTINCT ip.invoice_id)::int AS transactions
          FROM "${schema}".invoice_payments ip
          INNER JOIN "${schema}".invoices inv ON ip.invoice_id = inv.id
          LEFT JOIN (
            SELECT
              rp.method,
              SUM(COALESCE(rp.amount, 0)) AS refunded_amount
            FROM "${schema}".refund_payments rp
            INNER JOIN "${schema}".refunds r ON rp.refund_id = r.id
            INNER JOIN "${schema}".invoices inv2 ON r.invoice_id = inv2.id
            WHERE inv2.created_at >= :dateStart
              AND inv2.created_at <= :dateEnd
              AND inv2.status = 'Partially Refunded'
              AND r.status = 'Completed'
            GROUP BY rp.method
          ) rp_agg ON rp_agg.method::text = ip.method::text
          WHERE inv.created_at >= :dateStart
            AND inv.created_at <= :dateEnd
            AND inv.status IN ('Paid', 'Partially Refunded')
          GROUP BY ip.method
          ORDER BY amount DESC
        `),
        safeOwnerQuery(`
          SELECT
            inv.created_by AS user_id,
            COALESCE(u.full_name, u.username, 'Staff') AS name,
            GREATEST(0, COALESCE(SUM(inv.total_amount), 0) - COALESCE(SUM(ref_inv.refunded_amount), 0)) AS revenue,
            GREATEST(0, COALESCE(SUM(inv.total_meters), 0) - COALESCE(SUM(ref_inv.refunded_meters), 0)) AS meters,
            COALESCE(SUM(inv.total_discount), 0) AS total_discount,
            COUNT(inv.id)::int AS transactions,
            GREATEST(0, COALESCE(SUM(item_costs.cost), 0) - COALESCE(SUM(ref_inv.refunded_cost), 0)) AS cost
          FROM "${schema}".invoices inv
          LEFT JOIN "${schema}".users u ON u.id = inv.created_by
          LEFT JOIN (
            SELECT
              it.invoice_id,
              SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS cost
            FROM "${schema}".invoice_items it
            INNER JOIN "${schema}".invoices inv_sub ON it.invoice_id = inv_sub.id
            LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
            WHERE inv_sub.created_at >= :dateStart
              AND inv_sub.created_at <= :dateEnd
              AND inv_sub.status IN ('Paid', 'Partially Refunded')
            GROUP BY it.invoice_id
          ) item_costs ON item_costs.invoice_id = inv.id
          LEFT JOIN (
            SELECT
              r.invoice_id,
              SUM(COALESCE(r.total_amount, 0)) AS refunded_amount,
              SUM(COALESCE(ri_agg.refunded_meters, 0)) AS refunded_meters,
              SUM(COALESCE(ri_agg.refunded_cost, 0)) AS refunded_cost
            FROM "${schema}".refunds r
            INNER JOIN "${schema}".invoices inv_r ON r.invoice_id = inv_r.id
            LEFT JOIN (
              SELECT
                ri.refund_id,
                SUM(COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1)) AS refunded_meters,
                SUM(COALESCE(it2.cost_per_meter_snapshot, ii2.cost_per_meter, 0) * COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1)) AS refunded_cost
              FROM "${schema}".refund_items ri
              INNER JOIN "${schema}".refunds r_sub ON ri.refund_id = r_sub.id
              INNER JOIN "${schema}".invoices inv_rs ON r_sub.invoice_id = inv_rs.id
              LEFT JOIN "${schema}".invoice_items it2 ON ri.invoice_item_id = it2.id
              LEFT JOIN "${schema}".inventory_items ii2 ON ri.inventory_item_id = ii2.id
              WHERE r_sub.status = 'Completed'
                AND inv_rs.created_at >= :dateStart
                AND inv_rs.created_at <= :dateEnd
                AND inv_rs.status = 'Partially Refunded'
              GROUP BY ri.refund_id
            ) ri_agg ON ri_agg.refund_id = r.id
            WHERE r.status = 'Completed'
              AND inv_r.created_at >= :dateStart
              AND inv_r.created_at <= :dateEnd
              AND inv_r.status = 'Partially Refunded'
            GROUP BY r.invoice_id
          ) ref_inv ON ref_inv.invoice_id = inv.id
          WHERE inv.created_at >= :dateStart
            AND inv.created_at <= :dateEnd
            AND inv.status IN ('Paid', 'Partially Refunded')
          GROUP BY inv.created_by, u.full_name, u.username
          ORDER BY revenue DESC
          LIMIT 10
        `),
      safeOwnerQuery(`
        SELECT
          ii.id,
          COALESCE(NULLIF(ii.item_name, ''), CONCAT(ii.fabric_type, ' ', COALESCE(ii.color, ''))) AS name,
          ii.fabric_type,
          ii.pattern,
          ii.color,
          COALESCE(b.name, 'Main') AS branch_name,
          (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) AS stock_meters,
          COALESCE(ii.cost_per_meter, 0) AS cost_per_meter,
          (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1) * COALESCE(ii.cost_per_meter, 0)) AS tied_capital,
          GREATEST(0, EXTRACT(DAY FROM (NOW() - ii.created_at))::int) AS days_in_stock
        FROM "${schema}".inventory_items ii
        LEFT JOIN "${schema}".branches b ON b.id = ii.branch_id
        WHERE ii.status = 'In Stock'
          AND (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) > 0
          AND NOT EXISTS (
            SELECT 1
            FROM "${schema}".invoice_items it
            INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
            WHERE it.inventory_item_id = ii.id
              AND inv.created_at >= :dateStart
              AND inv.created_at <= :dateEnd
              AND inv.status IN ('Paid', 'Partially Refunded')
          )
        ORDER BY tied_capital DESC
        LIMIT 15
      `),
      safeOwnerQuery(`
        SELECT
          ii.id,
          COALESCE(NULLIF(ii.item_name, ''), CONCAT(ii.fabric_type, ' ', COALESCE(ii.color, ''))) AS name,
          ii.fabric_type,
          ii.pattern,
          ii.color,
          COALESCE(b.name, 'Main') AS branch_name,
          (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) AS stock_meters,
          (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1) * COALESCE(ii.cost_per_meter, 0)) AS tied_capital
        FROM "${schema}".inventory_items ii
        LEFT JOIN "${schema}".branches b ON b.id = ii.branch_id
        WHERE ii.status = 'In Stock'
          AND (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) > 0
          AND (COALESCE(ii.length_m, 0) * COALESCE(ii.quantity, 1)) <= 3.5
        ORDER BY stock_meters ASC
        LIMIT 15
      `),
    ]);

    const periodDays = Math.max(
      1,
      Math.ceil((new Date(todayEnd) - new Date(todayStart)) / (1000 * 60 * 60 * 24)),
    );

    const topItemsWithProfit = topItemsRevenue.map((item) => {
      const revenue = parseFloat(item.revenue || 0);
      const cost = parseFloat(item.cost || 0);
      const profit = revenue - cost;
      const meters = parseFloat(item.meters || 0);
      const stockMeters = parseFloat(item.stock_meters || 0);
      const dailyMetersBurn = meters / periodDays;
      const daysUntilStockout =
        dailyMetersBurn > 0 && stockMeters > 0
          ? Math.max(1, Math.round(stockMeters / dailyMetersBurn))
          : stockMeters <= 0
            ? 0
            : null;
      return {
        id: item.id,
        name: item.name,
        pattern: item.pattern || null,
        color: item.color || null,
        category: item.pattern || item.color || item.fabric_type || "-",
        fabric_type: item.fabric_type || null,
        revenue,
        profit,
        profit_margin: revenue > 0 ? (profit / revenue) * 100 : 0,
        quantity: parseInt(item.quantity || 0, 10),
        meters,
        stock_meters: stockMeters,
        days_until_stockout: daysUntilStockout,
      };
    });

    const totalPaymentAmt = paymentRows.reduce((s, r) => s + parseFloat(r.amount || 0), 0);
    const paymentMethods = paymentRows.map((r) => {
      const amt = parseFloat(r.amount || 0);
      return {
        method: r.method || "Cash",
        amount: amt,
        transactions: parseInt(r.transactions || 0, 10),
        percentage: totalPaymentAmt > 0 ? (amt / totalPaymentAmt) * 100 : 0,
      };
    });

    const staffPerformance = staffRows.map((r) => {
      const rev = parseFloat(r.revenue || 0);
      const cost = parseFloat(r.cost || 0);
      const profit = rev - cost;
      return {
        user_id: r.user_id,
        name: r.name || "Staff",
        revenue: rev,
        profit,
        profit_margin: rev > 0 ? (profit / rev) * 100 : 0,
        meters: parseFloat(r.meters || 0),
        total_discount: parseFloat(r.total_discount || 0),
        transactions: parseInt(r.transactions || 0, 10),
      };
    });

    const deadStock = deadStockRows.map((r) => ({
      id: r.id,
      name: r.name,
      fabric_type: r.fabric_type || "-",
      pattern: r.pattern || "-",
      color: r.color || "-",
      branch_name: r.branch_name || "Main",
      stock_meters: parseFloat(r.stock_meters || 0),
      cost_per_meter: parseFloat(r.cost_per_meter || 0),
      tied_capital: parseFloat(r.tied_capital || 0),
      days_in_stock: parseInt(r.days_in_stock || 0, 10),
    }));

    const remnants = remnantRows.map((r) => ({
      id: r.id,
      name: r.name,
      fabric_type: r.fabric_type || "-",
      pattern: r.pattern || "-",
      color: r.color || "-",
      branch_name: r.branch_name || "Main",
      stock_meters: parseFloat(r.stock_meters || 0),
      tied_capital: parseFloat(r.tied_capital || 0),
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
        payment_methods: paymentMethods,
        staff_performance: staffPerformance,
        dead_stock: deadStock,
        remnants: remnants,
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

