import { Op } from "sequelize";
import sequelize from "../../config/database.js";
import logger from "../../utils/logger.js";
import { cacheGet, cacheSet } from "../../config/redis.js";

export const getDashboardAnalytics = async (req, res) => {
  try {
    const {
      startDate,
      endDate,
      branchIds,
      compare = "false",
      compareType = "previous_period",
      refresh = "false",
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
      const branchArray = (Array.isArray(branchIds) ? branchIds : String(branchIds).split(","))
        .map((id) => parseInt(String(id).trim(), 10))
        .filter((id) => Number.isFinite(id) && id > 0);
      if (branchArray.length > 0) {
        branchFilter.branch_id = { [Op.in]: branchArray };
      }
    }

    const fetchPeriodData = async (periodStart, periodEnd, includeExtended = true) => {
      try {
        const startDateObj = periodStart instanceof Date ? periodStart : new Date(periodStart);
        const endDateObj = periodEnd instanceof Date ? periodEnd : new Date(periodEnd);

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
        const truncUnit = daysDiff <= 31 ? "day" : daysDiff <= 92 ? "week" : "month";

        const invoiceRefundJoinSql = `
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
                AND inv_rs.created_at BETWEEN :start AND :end
                AND inv_rs.status = 'Partially Refunded'
                ${branchSql.replace(/inv\./g, "inv_rs.")}
              GROUP BY ri.refund_id
            ) ri_agg ON ri_agg.refund_id = r.id
            WHERE r.status = 'Completed'
              AND inv_r.created_at BETWEEN :start AND :end
              AND inv_r.status = 'Partially Refunded'
              ${branchSql.replace(/inv\./g, "inv_r.")}
            GROUP BY r.invoice_id
          ) ref_inv ON ref_inv.invoice_id = inv.id
        `;

        const itemRefundJoinSql = `
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
              AND inv_r.created_at BETWEEN :start AND :end
              AND inv_r.status = 'Partially Refunded'
              ${branchSql.replace(/inv\./g, "inv_r.")}
            GROUP BY ri.invoice_item_id
          ) ref_item ON ref_item.invoice_item_id = it.id
        `;

        const safeQuery = async (sql) => {
          try {
            return await sequelize.query(sql, {
              replacements: baseReplacements,
              type: sequelize.QueryTypes.SELECT,
            });
          } catch (err) {
            logger.warn("Extended analytics query fallback", {
              component: "dashboard",
              error: err?.message,
            });
            return [];
          }
        };

        const [
          [kpiRow = {}],
          [refundTotals = {}],
          salesTrendRows,
          categoryRows,
          fabricRows,
          branchRows,
          paymentRows,
          staffRows,
          deadStockRows,
        ] = await Promise.all([
          sequelize.query(
            `
            SELECT
              COALESCE(SUM(inv.total_amount), 0) AS revenue,
              COALESCE(SUM(inv.total_meters), 0) AS meters_sold,
              COALESCE(SUM(inv.total_discount), 0) AS total_discount,
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
                SELECT SUM(COALESCE(ri.quantity_refunded, 1))::int
                FROM "${schema}".refund_items ri
                INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
                INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
                WHERE inv2.created_at BETWEEN :start AND :end
                  AND inv2.status = 'Partially Refunded'
                  AND r2.status = 'Completed'
                  ${branchSql.replace(/inv\./g, "inv2.")}
              ), 0) AS refunded_quantity,
              COALESCE((
                SELECT SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(ri.meters, 0) * COALESCE(ri.quantity_refunded, 1))
                FROM "${schema}".refund_items ri
                INNER JOIN "${schema}".refunds r2 ON ri.refund_id = r2.id
                INNER JOIN "${schema}".invoices inv2 ON r2.invoice_id = inv2.id
                LEFT JOIN "${schema}".invoice_items it ON ri.invoice_item_id = it.id
                LEFT JOIN "${schema}".inventory_items ii ON ri.inventory_item_id = ii.id
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
              TO_CHAR(DATE_TRUNC('${truncUnit}', inv.created_at AT TIME ZONE 'Asia/Kuwait'), 'YYYY-MM-DD') AS date,
              GREATEST(0, COALESCE(SUM(inv.total_amount), 0) - COALESCE(SUM(ref_inv.refunded_amount), 0)) AS revenue,
              GREATEST(0, COALESCE(SUM(inv.total_meters), 0) - COALESCE(SUM(ref_inv.refunded_meters), 0)) AS meters,
              COUNT(inv.id)::int AS quantity,
              GREATEST(0, COALESCE(SUM(item_costs.cost), 0) - COALESCE(SUM(ref_inv.refunded_cost), 0)) AS cost
            FROM "${schema}".invoices inv
            LEFT JOIN (
              SELECT
                it.invoice_id,
                SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS cost
              FROM "${schema}".invoice_items it
              INNER JOIN "${schema}".invoices inv_sub ON it.invoice_id = inv_sub.id
              LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
              WHERE inv_sub.created_at BETWEEN :start AND :end
                AND inv_sub.status IN ('Paid', 'Partially Refunded')
                ${branchSql.replace(/inv\./g, "inv_sub.")}
              GROUP BY it.invoice_id
            ) item_costs ON item_costs.invoice_id = inv.id
            ${invoiceRefundJoinSql}
            WHERE inv.created_at BETWEEN :start AND :end
              AND inv.status IN ('Paid', 'Partially Refunded')
              ${branchSql}
            GROUP BY DATE_TRUNC('${truncUnit}', inv.created_at AT TIME ZONE 'Asia/Kuwait')
            ORDER BY DATE_TRUNC('${truncUnit}', inv.created_at AT TIME ZONE 'Asia/Kuwait') ASC
            `,
            { replacements: baseReplacements, type: sequelize.QueryTypes.SELECT },
          ),
          sequelize.query(
            `
            SELECT
              COALESCE(NULLIF(ii.pattern, ''), COALESCE(it.fabric_type, ii.fabric_type, 'Other')) AS name,
              GREATEST(0, COALESCE(SUM(it.total_price), 0) - COALESCE(SUM(ref_item.refunded_amount), 0)) AS revenue,
              GREATEST(0, COALESCE(SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) - COALESCE(SUM(ref_item.refunded_cost), 0)) AS cost,
              GREATEST(0, COALESCE(SUM(COALESCE(it.quantity, 1)), 0) - COALESCE(SUM(ref_item.refunded_qty), 0))::int AS quantity,
              GREATEST(0, COALESCE(SUM(COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) - COALESCE(SUM(ref_item.refunded_meters), 0)) AS meters
            FROM "${schema}".invoice_items it
            INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
            LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
            ${itemRefundJoinSql}
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
              GREATEST(0, COALESCE(SUM(it.total_price), 0) - COALESCE(SUM(ref_item.refunded_amount), 0)) AS revenue,
              GREATEST(0, COALESCE(SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) - COALESCE(SUM(ref_item.refunded_cost), 0)) AS cost,
              GREATEST(0, COALESCE(SUM(COALESCE(it.quantity, 1)), 0) - COALESCE(SUM(ref_item.refunded_qty), 0))::int AS quantity,
              GREATEST(0, COALESCE(SUM(COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)), 0) - COALESCE(SUM(ref_item.refunded_meters), 0)) AS meters
            FROM "${schema}".invoice_items it
            INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
            LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
            ${itemRefundJoinSql}
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
              GREATEST(0, COALESCE(SUM(inv.total_amount), 0) - COALESCE(SUM(ref_inv.refunded_amount), 0)) AS revenue,
              GREATEST(0, COALESCE(SUM(inv.total_meters), 0) - COALESCE(SUM(ref_inv.refunded_meters), 0)) AS meters,
              COUNT(inv.id)::int AS quantity,
              GREATEST(0, COALESCE(SUM(item_costs.cost), 0) - COALESCE(SUM(ref_inv.refunded_cost), 0)) AS cost
            FROM "${schema}".invoices inv
            LEFT JOIN "${schema}".branches b ON b.id = inv.branch_id
            LEFT JOIN (
              SELECT
                it.invoice_id,
                SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS cost
              FROM "${schema}".invoice_items it
              INNER JOIN "${schema}".invoices inv_sub ON it.invoice_id = inv_sub.id
              LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
              WHERE inv_sub.created_at BETWEEN :start AND :end
                AND inv_sub.status IN ('Paid', 'Partially Refunded')
                ${branchSql.replace(/inv\./g, "inv_sub.")}
              GROUP BY it.invoice_id
            ) item_costs ON item_costs.invoice_id = inv.id
            ${invoiceRefundJoinSql}
            WHERE inv.created_at BETWEEN :start AND :end
              AND inv.status IN ('Paid', 'Partially Refunded')
              ${branchSql}
            GROUP BY inv.branch_id, b.name
            ORDER BY revenue DESC
            `,
            { replacements: baseReplacements, type: sequelize.QueryTypes.SELECT },
          ),
          includeExtended
            ? safeQuery(`
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
                  WHERE inv2.created_at BETWEEN :start AND :end
                    AND inv2.status = 'Partially Refunded'
                    AND r.status = 'Completed'
                    ${branchSql.replace(/inv\./g, "inv2.")}
                  GROUP BY rp.method
                ) rp_agg ON rp_agg.method::text = ip.method::text
                WHERE inv.created_at BETWEEN :start AND :end
                  AND inv.status IN ('Paid', 'Partially Refunded')
                  ${branchSql}
                GROUP BY ip.method
                ORDER BY amount DESC
              `)
            : Promise.resolve([]),
          includeExtended
            ? safeQuery(`
                SELECT
                  inv.created_by AS user_id,
                  COALESCE(u.full_name, u.username, 'Staff') AS name,
                  GREATEST(0, COALESCE(SUM(inv.total_amount), 0) - COALESCE(SUM(ref_inv.refunded_amount), 0)) AS revenue,
                  GREATEST(0, COALESCE(SUM(inv.total_meters), 0) - COALESCE(SUM(ref_inv.refunded_meters), 0)) AS meters,
                  COUNT(inv.id)::int AS transactions,
                  GREATEST(0, COALESCE(SUM(item_costs.cost), 0) - COALESCE(SUM(ref_inv.refunded_cost), 0)) AS cost
                FROM "${schema}".invoices inv
                LEFT JOIN "${schema}".users u ON u.id = inv.created_by
                LEFT JOIN (
                  SELECT
                    it.invoice_id,
                    SUM(COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)) AS cost
                  FROM "${schema}".invoice_items it
                  LEFT JOIN "${schema}".inventory_items ii ON it.inventory_item_id = ii.id
                  GROUP BY it.invoice_id
                ) item_costs ON item_costs.invoice_id = inv.id
                ${invoiceRefundJoinSql}
                WHERE inv.created_at BETWEEN :start AND :end
                  AND inv.status IN ('Paid', 'Partially Refunded')
                  ${branchSql}
                GROUP BY inv.created_by, u.full_name, u.username
                ORDER BY revenue DESC
                LIMIT 10
              `)
            : Promise.resolve([]),
          includeExtended
            ? safeQuery(`
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
                  ${branchSql.replace(/inv\./g, "ii.")}
                  AND NOT EXISTS (
                    SELECT 1
                    FROM "${schema}".invoice_items it
                    INNER JOIN "${schema}".invoices inv ON it.invoice_id = inv.id
                    WHERE it.inventory_item_id = ii.id
                      AND inv.created_at BETWEEN :start AND :end
                      AND inv.status IN ('Paid', 'Partially Refunded')
                  )
                ORDER BY tied_capital DESC
                LIMIT 15
              `)
            : Promise.resolve([]),
        ]);

        const refundedAmount = parseFloat(refundTotals.refunded_amount || 0);
        const refundedMeters = parseFloat(refundTotals.refunded_meters || 0);
        const refundedCost = parseFloat(refundTotals.refunded_cost || 0);
        const refundedQuantity = parseInt(refundTotals.refunded_quantity || 0, 10);

        const totalRevenue = Math.max(0, parseFloat(kpiRow.revenue || 0) - refundedAmount);
        const totalCost = Math.max(0, parseFloat(kpiRow.total_cost || 0) - refundedCost);
        const grossProfit = totalRevenue - totalCost;
        const profitMargin = totalRevenue > 0 ? (grossProfit / totalRevenue) * 100 : 0;
        const totalMetersSold = Math.max(0, parseFloat(kpiRow.meters_sold || 0) - refundedMeters);
        const totalTransactions = parseInt(kpiRow.transactions || 0, 10);
        const totalQuantity = Math.max(0, parseInt(kpiRow.total_quantity || 0, 10) - refundedQuantity);
        const avgOrderValue = totalTransactions > 0 ? totalRevenue / totalTransactions : 0;
        const avgMetersPerOrder = totalTransactions > 0 ? totalMetersSold / totalTransactions : 0;
        const totalDiscount = parseFloat(kpiRow.total_discount || 0);

        const salesTrendWithProfit = salesTrendRows.map((row) => {
          const rev = parseFloat(row.revenue || 0);
          const cost = parseFloat(row.cost || 0);
          return {
            date: row.date instanceof Date ? row.date.toISOString().split("T")[0] : String(row.date || ""),
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
            meters: parseFloat(row.meters || 0),
          };
        });

        const fabricDistribution = fabricRows.map((row) => {
          const rev = parseFloat(row.revenue || 0);
          const cost = parseFloat(row.cost || 0);
          const profit = rev - cost;
          return {
            fabric_type: row.fabric_type,
            revenue: rev,
            profit,
            profit_margin: rev > 0 ? (profit / rev) * 100 : 0,
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
            meters: parseFloat(row.meters || 0),
            quantity: parseInt(row.quantity || 0, 10),
          };
        });

        const totalPaymentAmount = paymentRows.reduce(
          (sum, row) => sum + parseFloat(row.amount || 0),
          0,
        );
        const paymentMethods = paymentRows.map((row) => {
          const amt = parseFloat(row.amount || 0);
          return {
            method: row.method || "Cash",
            amount: amt,
            transactions: parseInt(row.transactions || 0, 10),
            percentage: totalPaymentAmount > 0 ? (amt / totalPaymentAmount) * 100 : 0,
          };
        });

        const staffPerformance = staffRows.map((row) => {
          const rev = parseFloat(row.revenue || 0);
          const cost = parseFloat(row.cost || 0);
          const profit = rev - cost;
          const txCount = parseInt(row.transactions || 0, 10);
          return {
            user_id: row.user_id,
            name: row.name || "Staff",
            revenue: rev,
            profit,
            profit_margin: rev > 0 ? (profit / rev) * 100 : 0,
            meters: parseFloat(row.meters || 0),
            transactions: txCount,
            avg_order_value: txCount > 0 ? rev / txCount : 0,
          };
        });

        const deadStock = deadStockRows.map((row) => ({
          id: row.id,
          name: row.name,
          fabric_type: row.fabric_type || "-",
          pattern: row.pattern || "-",
          color: row.color || "-",
          branch_name: row.branch_name || "Main",
          stock_meters: parseFloat(row.stock_meters || 0),
          cost_per_meter: parseFloat(row.cost_per_meter || 0),
          tied_capital: parseFloat(row.tied_capital || 0),
          days_in_stock: parseInt(row.days_in_stock || 0, 10),
        }));

        return {
          kpi: {
            revenue: totalRevenue,
            profit: grossProfit,
            profit_margin: profitMargin,
            meters_sold: totalMetersSold,
            transactions: totalTransactions,
            quantity: totalQuantity,
            avg_order_value: avgOrderValue,
            avg_meters_per_order: avgMetersPerOrder,
            total_discount: totalDiscount,
            refunded_amount: refundedAmount,
          },
          charts: {
            sales_trend: salesTrendWithProfit,
            category_distribution: categoryDistribution,
            pattern_distribution: categoryDistribution,
            fabric_distribution: fabricDistribution,
            branch_performance: branchPerformance,
            payment_methods: paymentMethods,
            staff_performance: staffPerformance,
            dead_stock: deadStock,
          },
        };
      } catch (innerError) {
        logger.error("Error in fetchPeriodData", {
          component: "dashboard",
          error: innerError?.message,
          stack: innerError?.stack,
          start: periodStart instanceof Date ? periodStart : new Date(periodStart),
          end: periodEnd instanceof Date ? periodEnd : new Date(periodEnd),
        });
        throw innerError;
      }
    };

    const effectiveBranchKey =
      req.user.role !== "store_owner"
        ? `b_${req.user.branch_id}`
        : branchIds || "all";
    const startKey = start.toLocaleDateString("en-CA", { timeZone: "Asia/Kuwait" });
    const endKey = end.toLocaleDateString("en-CA", { timeZone: "Asia/Kuwait" });
    const cacheKey = `analytics:${req.tenant.slug}:${startKey}:${endKey}:${effectiveBranchKey}:${compare}:${compareType}`;
    const forceRefresh = refresh === "true" || refresh === true;
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
      forceRefresh,
      tenant: req.tenant.slug,
      daysDiff: Math.ceil(
        (new Date(endDate) - new Date(startDate)) / (1000 * 60 * 60 * 24),
      ),
    });

    const cachedData = !forceRefresh ? await cacheGet(cacheKey) : null;
    if (cachedData && cachedData.current) {
      dataSource = "cache";
      currentPeriod = cachedData.current;
      lastUpdated = cachedData.last_updated || lastUpdated;

      const nextUpdateDate = new Date(lastUpdated);
      nextUpdateDate.setHours(nextUpdateDate.getHours() + 1);
      nextUpdate = nextUpdateDate.toISOString();
    } else {
      currentPeriod = await fetchPeriodData(start, end, true);
      const nextUpdateDate = new Date();
      nextUpdateDate.setHours(nextUpdateDate.getHours() + 1);
      nextUpdate = nextUpdateDate.toISOString();
    }

    if (!currentPeriod) {
      currentPeriod = await fetchPeriodData(start, end, true);
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
        false,
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
        profit_margin:
          (currentPeriod.kpi.profit_margin || 0) -
          (previousPeriod.kpi.profit_margin || 0),
        meters_sold: calculateChange(
          currentPeriod.kpi.meters_sold,
          previousPeriod.kpi.meters_sold,
        ),
        transactions: calculateChange(
          currentPeriod.kpi.transactions,
          previousPeriod.kpi.transactions,
        ),
        avg_order_value: calculateChange(
          currentPeriod.kpi.avg_order_value,
          previousPeriod.kpi.avg_order_value,
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
        COALESCE(NULLIF(ii.item_name, ''), CONCAT(ii.fabric_type, ' ', COALESCE(ii.color, ''))) AS name,
        ii.pattern,
        ii.color,
        COALESCE(ii.fabric_type, it.fabric_type) AS fabric_type,
        GREATEST(0, COALESCE(SUM(it.total_price), 0) - COALESCE(SUM(ref_item.refunded_amount), 0)) AS revenue,
        GREATEST(0, COALESCE(SUM(it.total_price), 0) - COALESCE(SUM(ref_item.refunded_amount), 0)) - GREATEST(0, COALESCE(SUM(
          COALESCE(it.cost_per_meter_snapshot, ii.cost_per_meter, 0) * COALESCE(it.meters, 0) * COALESCE(it.quantity, 1)
        ), 0) - COALESCE(SUM(ref_item.refunded_cost), 0)) AS profit,
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
        LEFT JOIN "${schema}".invoice_items it2 ON ri.invoice_item_id = it2.id
        LEFT JOIN "${schema}".inventory_items ii2 ON ri.inventory_item_id = ii2.id
        WHERE r.status = 'Completed'
        GROUP BY ri.invoice_item_id
      ) ref_item ON ref_item.invoice_item_id = it.id
      WHERE inv.created_at BETWEEN :startDate AND :endDate
        AND inv.status IN ('Paid', 'Partially Refunded')
        ${branchSql}
      GROUP BY ii.id, ii.item_name, ii.pattern, ii.color, COALESCE(ii.fabric_type, it.fabric_type)
      HAVING GREATEST(0, COALESCE(SUM(it.total_price), 0) - COALESCE(SUM(ref_item.refunded_amount), 0)) > 0
      ORDER BY ${orderColumn} DESC
      LIMIT :limit
      `,
      {
        replacements,
        type: sequelize.QueryTypes.SELECT,
      },
    );

    const data = rows.map((item) => {
      const revenue = parseFloat(item.revenue) || 0;
      const profit = parseFloat(item.profit) || 0;
      return {
        id: item.id,
        name: item.name,
        category: item.pattern || item.color || item.fabric_type || "-",
        pattern: item.pattern || null,
        color: item.color || null,
        fabric_type: item.fabric_type || null,
        revenue,
        profit,
        profit_margin: revenue > 0 ? (profit / revenue) * 100 : 0,
        quantity: parseInt(item.quantity, 10) || 0,
        meters: parseFloat(item.meters) || 0,
      };
    });

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
