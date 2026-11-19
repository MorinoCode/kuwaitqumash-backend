import { Op } from "sequelize";
import sequelize from "../../config/database.js";
import Invoice from "./invoice.model.js";
import { generateCreditNotePDF } from "../../utils/invoiceGenerator.js";
import InvoiceItem from "./invoice-item.model.js";
import Refund from "./refund.model.js";
import RefundItem from "./refund-item.model.js";
import RefundPayment from "./refund-payment.model.js";
import InventoryItem from "../inventory/item.model.js";
import Customer from "../customers/customer.model.js";
import User from "../auth/user.model.js";
import Branch from "../store/branch.model.js";
import logger from "../../utils/logger.js";
import { shouldRearmAlert } from "../../utils/lowStock.js";
import { applyRefundToStock } from "../../utils/stock.js";
import { invalidateDashboardCache } from "../../utils/dashboard-cache.js";
import { startOfKuwaitDay, endOfKuwaitDay } from "../../utils/kuwaitTime.js";

export const getInvoiceForRefund = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const idStr = String(id || "").trim();

    if (!idStr) {
      return res.status(400).json({ message: "Invalid invoice ID or number" });
    }

    const isNumeric = /^\d+$/.test(idStr);
    let invoice;

    if (isNumeric) {
      invoice = await Invoice.schema(schema).findByPk(parseInt(idStr, 10), {
        include: [
          { model: InvoiceItem.schema(schema), as: "items" },
          { model: Customer.schema(schema), as: "customer", attributes: ["full_name", "phone"] },
          { model: Branch.schema(schema), as: "branch", attributes: ["name"] },
        ],
      });
    } else {
      invoice = await Invoice.schema(schema).findOne({
        where: { invoice_number: { [Op.iLike]: idStr } },
        include: [
          { model: InvoiceItem.schema(schema), as: "items" },
          { model: Customer.schema(schema), as: "customer", attributes: ["full_name", "phone"] },
          { model: Branch.schema(schema), as: "branch", attributes: ["name"] },
        ],
      });
    }

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    if (invoice.status === "Refunded") {
      return res.status(400).json({ message: "Invoice is already fully refunded" });
    }
    if (invoice.status === "Void") {
      return res.status(400).json({ message: "Voided invoices cannot be refunded" });
    }
    if (invoice.status !== "Paid" && invoice.status !== "Partially Refunded") {
      return res.status(400).json({ message: "Only paid invoices can be refunded" });
    }

    if (req.user.role !== "store_owner" && invoice.branch_id !== req.user.branch_id) {
      return res.status(403).json({ message: "Access denied to this invoice" });
    }

    const items = invoice.items || [];
    const itemIds = items.map((i) => i.id).filter((id) => id != null);
    let refundItems = [];
    if (itemIds.length > 0) {
      try {
        refundItems = await RefundItem.schema(schema).findAll({
          where: { invoice_item_id: { [Op.in]: itemIds } },
          attributes: ["invoice_item_id", "quantity_refunded", "meters", "amount_refunded"],
        });
      } catch (refundQueryErr) {
        logger.warn("RefundItem query failed (table may not exist)", {
          component: "refund",
          schema,
          error: refundQueryErr?.message,
        });
      }
    }

    const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
    const refundedByItem = {};
    refundItems.forEach((ri) => {
      if (!refundedByItem[ri.invoice_item_id]) {
        refundedByItem[ri.invoice_item_id] = { qty: 0, meters: 0, amount: 0 };
      }
      const rQty = parseInt(ri.quantity_refunded, 10) || 1;
      refundedByItem[ri.invoice_item_id].qty += rQty;
      refundedByItem[ri.invoice_item_id].meters = round3(
        refundedByItem[ri.invoice_item_id].meters + parseFloat(ri.meters || 0) * rQty,
      );
      refundedByItem[ri.invoice_item_id].amount = round3(
        refundedByItem[ri.invoice_item_id].amount + parseFloat(ri.amount_refunded || 0),
      );
    });

    const itemsWithRefundable = items.map((item) => {
      const refunded = refundedByItem[item.id] || { qty: 0, meters: 0, amount: 0 };
      const itemQty = parseInt(item.quantity, 10) || 1;
      const itemMeters = parseFloat(item.meters || 0);
      const totalMeters = round3(itemMeters * itemQty);
      const metersAvailable = Math.max(0, round3(totalMeters - refunded.meters));
      const qtyAvailable =
        totalMeters > 0
          ? metersAvailable > 0.001
            ? Math.max(1, Math.min(itemQty, Math.ceil(metersAvailable / Math.max(itemMeters, 0.001))))
            : 0
          : Math.max(0, itemQty - refunded.qty);
      const amountRefundable = Math.max(
        0,
        round3(parseFloat(item.total_price || 0) - refunded.amount),
      );

      return {
        id: item.id,
        invoice_item_id: item.id,
        inventory_item_id: item.inventory_item_id,
        item_name: item.item_name,
        fabric_type: item.fabric_type,
        meters: itemMeters,
        total_meters: totalMeters,
        meters_refunded: refunded.meters,
        meters_available: metersAvailable,
        quantity: itemQty,
        quantity_refunded: refunded.qty,
        quantity_available: qtyAvailable,
        total_price: parseFloat(item.total_price),
        amount_refunded: refunded.amount,
        amount_refundable: amountRefundable,
      };
    });

    const totalRefundable = itemsWithRefundable.reduce((s, i) => Math.round((s + i.amount_refundable) * 1000) / 1000, 0);

    res.json({
      success: true,
      data: {
        invoice: {
          id: invoice.id,
          invoice_number: invoice.invoice_number,
          total_amount: parseFloat(invoice.total_amount),
          status: invoice.status,
          customer: invoice.customer,
          branch: invoice.branch,
          createdAt: invoice.createdAt,
        },
        items: itemsWithRefundable,
        total_refundable: totalRefundable.toFixed(3),
      },
    });
  } catch (error) {
    logger.error("Get invoice for refund error", {
      component: "refund",
      error: error?.message,
      stack: error?.stack,
    });
    const devMsg = process.env.NODE_ENV === "development" ? ` (${error?.message})` : "";
    res.status(500).json({ message: `Failed to load invoice. Please try again.${devMsg}` });
  }
};

export const createRefund = async (req, res) => {
  const schema = req.tenant.db_schema;
  const { invoice_id, items, payments, notes } = req.body;

  let t;
  try {
    t = await sequelize.transaction();
    await sequelize.query(`SET LOCAL search_path TO "${schema}", public`, { transaction: t });

    const invoice = await Invoice.schema(schema).findByPk(invoice_id, {
      transaction: t,
      lock: t.LOCK.UPDATE,
    });

    if (!invoice) throw new Error("Invoice not found");

    const invoiceItems = await InvoiceItem.schema(schema).findAll({
      where: { invoice_id },
      transaction: t,
    });
    invoice.items = invoiceItems;

    if (invoice.status === "Refunded") {
      throw new Error("Invoice is already fully refunded");
    }
    if (invoice.status === "Void") {
      throw new Error("Voided invoices cannot be refunded");
    }
    if (invoice.status !== "Paid" && invoice.status !== "Partially Refunded") {
      throw new Error("Only paid invoices can be refunded");
    }

    if (req.user.role !== "store_owner" && invoice.branch_id !== req.user.branch_id) {
      throw new Error("Access denied to this invoice");
    }

    const round3 = (v) => Math.round((Number(v) || 0) * 1000) / 1000;
    const refundItemsByInvItem = {};
    const refundMetersByInvItem = {};
    const refundAmountsByInvItem = {};
    const existingRefunds = await RefundItem.schema(schema).findAll({
      where: { invoice_item_id: items.map((i) => i.invoice_item_id) },
      attributes: ["invoice_item_id", "quantity_refunded", "meters", "amount_refunded"],
      transaction: t
    });
    existingRefunds.forEach((r) => {
      const invItemId = r.invoice_item_id;
      const rQty = parseInt(r.quantity_refunded, 10) || 1;
      refundItemsByInvItem[invItemId] =
        (refundItemsByInvItem[invItemId] || 0) + rQty;
      refundMetersByInvItem[invItemId] = round3(
        (refundMetersByInvItem[invItemId] || 0) + parseFloat(r.meters || 0) * rQty,
      );
      refundAmountsByInvItem[invItemId] = round3(
        (refundAmountsByInvItem[invItemId] || 0) + parseFloat(r.amount_refunded || 0),
      );
    });

    const allPreviousInvoiceRefunds = await Refund.schema(schema).findAll({
      where: { invoice_id: invoice.id, status: "Completed" },
      attributes: ["total_amount"],
      transaction: t,
    });
    const alreadyRefundedInvoiceTotal = allPreviousInvoiceRefunds.reduce(
      (sum, r) => sum + parseFloat(r.total_amount || 0),
      0,
    );
    const invoiceTotal = parseFloat(invoice.total_amount || 0);
    const maxInvoiceRefundable = Math.max(
      0,
      Math.round((invoiceTotal - alreadyRefundedInvoiceTotal) * 1000) / 1000,
    );

    const invoiceItemsMap = {};
    invoice.items.forEach((i) => {
      invoiceItemsMap[i.id] = i;
    });

    let totalRefundAmount = 0;
    const validatedItems = [];
    const seenInvoiceItemIds = new Set();

    for (const it of items) {
      if (seenInvoiceItemIds.has(it.invoice_item_id)) {
        throw new Error(`Duplicate refund item detected for invoice item ID: ${it.invoice_item_id}`);
      }
      seenInvoiceItemIds.add(it.invoice_item_id);
      const invItem = invoiceItemsMap[it.invoice_item_id];
      if (!invItem) {
        throw new Error(`Invalid invoice item ID: ${it.invoice_item_id}`);
      }
      const invItemQty = parseInt(invItem.quantity, 10) || 1;
      const invItemMeters = parseFloat(invItem.meters || 0);
      const totalSoldMeters = round3(invItemMeters * invItemQty);
      const alreadyRefundedMeters = refundMetersByInvItem[it.invoice_item_id] || 0;
      const maxMetersAvailable = Math.max(0, round3(totalSoldMeters - alreadyRefundedMeters));

      const isMeteredRefund =
        it.meters_refunded !== undefined &&
        it.meters_refunded !== null &&
        totalSoldMeters > 0;

      let effectiveMeters;
      let effectiveQty;

      if (isMeteredRefund) {
        const requestedMeters = round3(parseFloat(it.meters_refunded));
        if (isNaN(requestedMeters) || requestedMeters <= 0) continue;
        if (requestedMeters > maxMetersAvailable + 0.001) {
          throw new Error(
            `Cannot refund ${requestedMeters.toFixed(3)} m of item "${invItem.item_name}". Maximum available: ${maxMetersAvailable.toFixed(3)} m`,
          );
        }
        effectiveMeters = requestedMeters;
        effectiveQty = 1;
      } else {
        const alreadyRefunded = refundItemsByInvItem[it.invoice_item_id] || 0;
        const maxQty = Math.max(0, invItemQty - alreadyRefunded);
        if (it.quantity_refunded > maxQty) {
          throw new Error(`Cannot refund ${it.quantity_refunded} of item "${invItem.item_name}". Maximum available: ${maxQty}`);
        }
        if (it.quantity_refunded < 1) continue;
        if (totalSoldMeters > 0 && round3(invItemMeters * it.quantity_refunded) > maxMetersAvailable + 0.001) {
          throw new Error(
            `Cannot refund ${(invItemMeters * it.quantity_refunded).toFixed(3)} m of item "${invItem.item_name}". Maximum available: ${maxMetersAvailable.toFixed(3)} m`,
          );
        }
        effectiveMeters = invItemMeters;
        effectiveQty = it.quantity_refunded;
      }

      const amount = parseFloat(it.amount_refunded);
      if (isNaN(amount) || amount < 0) {
        throw new Error("Invalid amount for refund item");
      }

      const itemTotalPrice = parseFloat(invItem.total_price || 0);
      const alreadyRefundedAmount = refundAmountsByInvItem[it.invoice_item_id] || 0;
      const maxItemRefundable = Math.max(
        0,
        Math.round((itemTotalPrice - alreadyRefundedAmount) * 1000) / 1000,
      );
      if (amount > maxItemRefundable + 0.005) {
        throw new Error(
          `Cannot refund ${amount.toFixed(3)} KWD for item "${invItem.item_name}". Maximum refundable balance remaining is ${maxItemRefundable.toFixed(3)} KWD.`,
        );
      }

      validatedItems.push({
        invoice_item_id: invItem.id,
        inventory_item_id: invItem.inventory_item_id,
        meters: effectiveMeters,
        quantity_refunded: effectiveQty,
        amount_refunded: amount,
      });
      totalRefundAmount = Math.round((totalRefundAmount + amount) * 1000) / 1000;
    }

    if (validatedItems.length === 0) {
      throw new Error("No valid items to refund");
    }

    if (totalRefundAmount > maxInvoiceRefundable + 0.005) {
      throw new Error(
        `Total refund amount (${totalRefundAmount.toFixed(3)} KWD) exceeds remaining refundable invoice balance (${maxInvoiceRefundable.toFixed(3)} KWD).`,
      );
    }

    const paymentsTotal = payments.reduce((s, p) => Math.round((s + parseFloat(p.amount || 0)) * 1000) / 1000, 0);
    if (Math.abs(paymentsTotal - totalRefundAmount) > 0.01) {
      throw new Error(`Payments total (${paymentsTotal.toFixed(3)}) must match refund amount (${totalRefundAmount.toFixed(3)})`);
    }

    const refundNumber = `REF-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    const lockKey = 1000;
    await sequelize.query('SELECT pg_advisory_xact_lock(:key)', { replacements: { key: lockKey }, transaction: t });

    const year = new Date().getFullYear();
    const prefix = `CN-${year}-`;
    const [cnResult] = await sequelize.query(
      `SELECT COALESCE(MAX(
        CAST(REGEXP_REPLACE(credit_note_number, '^CN-[0-9]+-', '') AS INTEGER)
      ), 0) + 1 AS next_num
      FROM "${schema}".refunds
      WHERE credit_note_number IS NOT NULL AND credit_note_number LIKE :prefix`,
      { replacements: { prefix: `${prefix}%` }, type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    const nextNum = cnResult?.next_num || 1;
    const creditNoteNumber = `${prefix}${String(nextNum).padStart(4, "0")}`;

    const refund = await Refund.schema(schema).create(
      {
        invoice_id: invoice.id,
        refund_number: refundNumber,
        credit_note_number: creditNoteNumber,
        total_amount: totalRefundAmount,
        status: "Completed",
        notes: notes || null,
        branch_id: invoice.branch_id,
        created_by: req.user.id,
      },
      { transaction: t }
    );

    for (const it of validatedItems) {
      await RefundItem.schema(schema).create(
        {
          refund_id: refund.id,
          invoice_item_id: it.invoice_item_id,
          inventory_item_id: it.inventory_item_id,
          meters: it.meters,
          quantity_refunded: it.quantity_refunded,
          amount_refunded: it.amount_refunded,
        },
        { transaction: t }
      );

      const invItem = await InventoryItem.schema(schema).findByPk(it.inventory_item_id, {
        transaction: t,
        lock: t.LOCK.UPDATE,
      });
      if (invItem) {
        const restored = applyRefundToStock(
          invItem,
          it.meters,
          it.quantity_refunded,
        );
        invItem.quantity = restored.quantity;
        invItem.length_m = restored.length_m;
        if (invItem.status !== "In Stock" && restored.quantity > 0) {
          invItem.status = "In Stock";
        }
        if (shouldRearmAlert(invItem)) {
          invItem.alert_dismissed_at = null;
        }
        await invItem.save({ transaction: t });
      }
    }

    for (const p of payments) {
      await RefundPayment.schema(schema).create(
        {
          refund_id: refund.id,
          method: p.method,
          amount: parseFloat(p.amount),
          reference_number: p.reference_number || null,
        },
        { transaction: t }
      );
    }

    const [sumResult] = await sequelize.query(
      `SELECT COALESCE(SUM(total_amount), 0)::float AS total FROM "${schema}".refunds WHERE invoice_id = :invoiceId`,
      { replacements: { invoiceId: invoice.id }, type: sequelize.QueryTypes.SELECT, transaction: t }
    );
    const totalRefundedSoFar = parseFloat(sumResult?.total || 0);
    const newStatus =
      totalRefundedSoFar >= invoiceTotal - 0.01
        ? "Refunded"
        : totalRefundedSoFar > 0
          ? "Partially Refunded"
          : invoice.status;
    if (newStatus !== invoice.status) {
      invoice.status = newStatus;
      await invoice.save({ transaction: t });
    }

    await t.commit();
    await invalidateDashboardCache(req.tenant.slug);

    const fullRefund = await Refund.schema(schema).findByPk(refund.id, {
      include: [
        { model: RefundItem.schema(schema), as: "items" },
        { model: RefundPayment.schema(schema), as: "payments" },
      ],
    });

    res.status(201).json({
      success: true,
      message: "Refund completed successfully",
      data: fullRefund,
    });
  } catch (error) {
    if (t && !t.finished) await t.rollback();
    logger.error("Create refund error", {
      component: "refund",
      error: error?.message,
      stack: error?.stack,
    });

    if (error?.message === "Invoice not found") {
      return res.status(404).json({ message: "Invoice not found" });
    }
    if (error?.message === "Access denied to this invoice") {
      return res.status(403).json({ message: "Access denied to this invoice" });
    }

    res.status(400).json({
      message: error?.message || "Failed to process refund. Please try again.",
    });
  }
};

export const getCreditNotePDF = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const safeDisposition = req.query.disposition === "inline" ? "inline" : "attachment";

    if (!id || isNaN(id)) {
      return res.status(400).json({ message: "Invalid refund ID" });
    }

    const refund = await Refund.schema(schema).findByPk(id, {
      include: [
        {
          model: RefundItem.schema(schema),
          as: "items",
          include: [
            {
              model: InvoiceItem.schema(schema),
              as: "invoice_item",
              attributes: ["item_name", "fabric_type", "meters"],
            },
          ],
        },
        { model: RefundPayment.schema(schema), as: "payments" },
      ],
    });

    if (!refund) return res.status(404).json({ message: "Refund not found" });

    if (req.user.role !== "store_owner" && refund.branch_id !== req.user.branch_id) {
      return res.status(403).json({ message: "Access denied to this refund" });
    }

    const invoice = await Invoice.schema(schema).findByPk(refund.invoice_id, {
      include: [
        { model: Customer.schema(schema), as: "customer" },
        { model: User.schema(schema), as: "creator", attributes: ["full_name"] },
      ],
    });

    if (!invoice) return res.status(404).json({ message: "Invoice not found" });

    const branch = await Branch.schema(schema).findByPk(refund.branch_id);
    const branchName = branch?.name || "Branch";
    const branchLogoUrl = branch?.logo_url || null;

    const branchInfo = {
      location: branch?.location,
      phone: branch?.phone,
      storeName: req.tenant?.name || branchName,
    };

    const { buffer } = await generateCreditNotePDF(
      refund.toJSON(),
      invoice.toJSON(),
      invoice.customer?.toJSON(),
      invoice.creator?.toJSON(),
      branchName,
      branchLogoUrl,
      branchInfo
    );

    const cnNum = refund.credit_note_number || refund.refund_number || `refund-${refund.id}`;
    const filename = `credit-note-${cnNum}.pdf`;
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader(
      "Content-Disposition",
      `${safeDisposition}; filename="${filename}"`
    );
    res.send(buffer);
  } catch (error) {
    logger.error("Get Credit Note PDF error", {
      component: "refund",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to generate Credit Note PDF." });
  }
};

export const getRefunds = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { invoice_id, branch_id, branch_ids, page = 1, limit = 20, search, start_date, end_date } = req.query;

    const where = {};
    if (invoice_id) where.invoice_id = invoice_id;
    if (req.user.role !== "store_owner") {
      where.branch_id = req.user.branch_id;
    } else if (branch_ids && String(branch_ids).trim()) {
      const ids = String(branch_ids)
        .split(",")
        .map((v) => parseInt(v.trim(), 10))
        .filter((v) => Number.isFinite(v) && v > 0);
      if (ids.length > 0) {
        where.branch_id = { [Op.in]: ids };
      }
    } else if (branch_id) {
      where.branch_id = branch_id;
    }

    if (start_date || end_date) {
      where.createdAt = {};
      if (start_date) {
        where.createdAt[Op.gte] = startOfKuwaitDay(start_date);
      }
      if (end_date) {
        where.createdAt[Op.lte] = endOfKuwaitDay(end_date);
      }
    }

    if (search && String(search).trim()) {
      const searchStr = `%${String(search).trim()}%`;
      where[Op.or] = [
        { credit_note_number: { [Op.iLike]: searchStr } },
        { refund_number: { [Op.iLike]: searchStr } },
        { "$invoice.invoice_number$": { [Op.iLike]: searchStr } },
      ];
    }

    const refunds = await Refund.schema(schema).findAndCountAll({
      where,
      include: [
        {
          model: Invoice.schema(schema),
          as: "invoice",
          attributes: ["invoice_number", "total_amount"],
          required: !!where[Op.or],
        },
        { model: User.schema(schema), as: "creator", attributes: ["full_name"] },
      ],
      order: [["createdAt", "DESC"]],
      limit: Math.min(parseInt(limit, 10) || 20, 100),
      offset: (Math.max(1, parseInt(page, 10)) - 1) * (parseInt(limit, 10) || 20),
    });

    res.json({
      success: true,
      data: refunds.rows,
      pagination: {
        totalItems: refunds.count,
        page: parseInt(page, 10) || 1,
        limit: parseInt(limit, 10) || 20,
      },
    });
  } catch (error) {
    logger.error("Get refunds error", { component: "refund", error: error?.message });
    res.status(500).json({ message: "Failed to load refunds." });
  }
};
