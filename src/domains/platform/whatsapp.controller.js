import WhatsappConfig from "../platform/whatsapp.config.model.js";
import Customer from "../customers/customer.model.js";
import sequelize from "../../config/database.js";
import { Op, QueryTypes } from "sequelize";
import { getRedisClient, isRedisEnabled } from "../../config/redis.js";
import {
  WA_CMD_CHANNEL,
  createBullRedisConnection,
  enqueueBulkMessages,
  getSessionKey,
  getWaEventChannel,
} from "../../queues/whatsapp.queue.js";
import {
  clearWhatsAppStatusCache,
  getSessionStatusFromStore,
} from "../../utils/whatsapp-status.js";
import { normalizePhone } from "../../utils/phone.utils.js";
import logger from "../../utils/logger.js";

const useWorkerBridge = () =>
  isRedisEnabled() && process.env.WA_SEPARATE_WORKER !== "false";

const resolveStatus = async (tenantSlug, branchId = null) => {
  if (useWorkerBridge()) {
    return getSessionStatusFromStore(tenantSlug, branchId);
  }
  const whatsappService = await import("../../utils/whatsapp.service.js");
  return whatsappService.getSessionStatus(tenantSlug, branchId);
};

export const getStatus = async (req, res) => {
  try {
    const branchId = req.query.branch_id
      ? Number.parseInt(req.query.branch_id, 10)
      : null;
    const status = await resolveStatus(req.tenant.slug, branchId);
    let invoice_enabled = true;
    if (branchId && Number.isFinite(branchId) && req.tenant?.db_schema) {
      try {
        const Branch = sequelize.models.Branch;
        if (Branch) {
          const branch = await Branch.schema(req.tenant.db_schema).findByPk(branchId, {
            attributes: ["id", "whatsapp_invoice_enabled"],
          });
          if (branch) {
            invoice_enabled = Boolean(branch.whatsapp_invoice_enabled);
          }
        }
      } catch {
        invoice_enabled = true;
      }
    }
    res.json({ success: true, data: { ...status, invoice_enabled } });
  } catch (error) {
    logger.error("WhatsApp Error", {
      component: "whatsapp.controller",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to process request. Please try again." });
  }
};

export const connect = async (req, res) => {
  const tenantSlug = req.tenant.slug;
  const branchId = req.query.branch_id
    ? Number.parseInt(req.query.branch_id, 10)
    : null;
  let ended = false;
  let subscriber = null;
  let timeoutId = null;

  const log = (msg, ctx = {}) =>
    logger.info(msg, {
      component: "whatsapp.controller",
      tenantSlug,
      branchId,
      ...ctx,
    });
  const logErr = (msg, ctx = {}) =>
    logger.error(msg, {
      component: "whatsapp.controller",
      tenantSlug,
      branchId,
      ...ctx,
    });

  log("connect SSE start");
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const sendEvent = (type, data) => {
    if (ended) return;
    try {
      res.write(`data: ${JSON.stringify({ type, data })}\n\n`);
      log("SSE sent", { type });
    } catch (e) {
      logErr("SSE write error", { type, error: e?.message });
    }
  };

  const finish = () => {
    if (ended) return;
    ended = true;
    if (timeoutId) clearTimeout(timeoutId);
    if (subscriber) {
      subscriber.unsubscribe().catch(() => {});
      subscriber.quit().catch(() => {});
      subscriber = null;
    }
    try {
      res.end();
    } catch (endError) {
      logErr("Failed to end SSE response", { error: endError?.message });
    }
    log("connect SSE finish");
  };

  const handleWorkerEvent = (event) => {
    try {
      if (event.type === "qr") {
        sendEvent("qr", event.data);
      } else if (event.type === "restarting") {
        sendEvent("restarting", event.data || "Linking device…");
      } else if (event.type === "connected") {
        const uid = event.user?.id;
        const phone =
          typeof uid === "string" ? uid.split(":")[0] : event.user?.phone || "";
        sendEvent("connected", {
          phone: phone || "",
          name: event.user?.name || "",
        });
        finish();
      } else if (event.type === "closed") {
        sendEvent("closed", event.data || "Connection closed.");
        finish();
      } else if (event.type === "error") {
        sendEvent("error", event.data || "Connection failed.");
        finish();
      }
    } catch (e) {
      logErr("connect callback error", {
        eventType: event?.type,
        error: e?.message,
      });
      sendEvent("error", e?.message || "Connection error.");
      finish();
    }
  };

  sendEvent("connecting", { message: "Waiting for QR..." });
  req.on("close", () => {
    log("connect SSE req close");
    finish();
  });

  try {
    if (useWorkerBridge()) {
      const current = await getSessionStatusFromStore(tenantSlug, branchId);
      if (current?.is_ready) {
        sendEvent("connected", {
          phone: current.phone_connected || "",
          name: "",
        });
        finish();
        return;
      }

      const sessionKey = getSessionKey(tenantSlug, branchId);
      const evtChannel = getWaEventChannel(sessionKey);
      subscriber = createBullRedisConnection();
      const publisher = getRedisClient();

      if (!subscriber || !publisher) {
        sendEvent("error", "Redis worker bridge unavailable.");
        finish();
        return;
      }

      await subscriber.subscribe(evtChannel);
      subscriber.on("message", (_ch, raw) => {
        try {
          const parsed = JSON.parse(raw);
          handleWorkerEvent(parsed);
        } catch {
          // Ignore malformed event payloads
        }
      });

      timeoutId = setTimeout(() => {
        sendEvent("error", "WhatsApp QR connection timed out.");
        finish();
      }, 120_000);

      await publisher.publish(
        WA_CMD_CHANNEL,
        JSON.stringify({ action: "connect", tenantSlug, branchId }),
      );
      return;
    }

    const whatsappService = await import("../../utils/whatsapp.service.js");
    await whatsappService.connectToWhatsApp(tenantSlug, handleWorkerEvent, {
      branchId,
    });
  } catch (err) {
    logErr("connect controller failed", {
      error: err?.message,
      stack: err?.stack,
    });
    sendEvent("error", err?.message || "Failed to connect.");
    finish();
  }
};

export const disconnect = async (req, res) => {
  try {
    const branchId = req.query.branch_id
      ? Number.parseInt(req.query.branch_id, 10)
      : null;

    if (useWorkerBridge()) {
      const publisher = getRedisClient();
      if (publisher) {
        await publisher.publish(
          WA_CMD_CHANNEL,
          JSON.stringify({
            action: "disconnect",
            tenantSlug: req.tenant.slug,
            branchId,
          }),
        );
      }
      await clearWhatsAppStatusCache(req.tenant.slug, branchId);
      const where = { tenant_slug: req.tenant.slug };
      if (branchId !== null && branchId !== undefined) {
        where.branch_id = branchId;
      } else {
        where.branch_id = { [Op.is]: null };
      }
      await WhatsappConfig.update({ session_status: "DISCONNECTED" }, { where });
      return res.json({ success: true, message: "Disconnected successfully." });
    }

    const whatsappService = await import("../../utils/whatsapp.service.js");
    const success = await whatsappService.logoutWhatsApp(
      req.tenant.slug,
      branchId,
    );
    if (success) {
      return res.json({ success: true, message: "Disconnected successfully." });
    }
    return res.status(400).json({ message: "Failed to disconnect." });
  } catch (error) {
    logger.error("WhatsApp Error", {
      component: "whatsapp.controller",
      error: error?.message,
      stack: error?.stack,
    });
    return res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const updateSettings = async (req, res) => {
  try {
    const { is_enabled, owner_phone, manager_phone } = req.body;

    let config = await WhatsappConfig.findOne({
      where: { tenant_slug: req.tenant.slug },
    });

    if (!config) {
      config = await WhatsappConfig.create({
        tenant_slug: req.tenant.slug,
        is_enabled,
        owner_phone,
        manager_phone,
      });
    } else {
      await config.update({ is_enabled, owner_phone, manager_phone });
    }

    res.json({ success: true, message: "Settings updated.", data: config });
  } catch (error) {
    logger.error("WhatsApp Error", {
      component: "whatsapp.controller",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to process request. Please try again." });
  }
};

export const getSettings = async (req, res) => {
  try {
    const config = await WhatsappConfig.findOne({
      where: { tenant_slug: req.tenant.slug },
    });
    res.json({ success: true, data: config || {} });
  } catch (error) {
    logger.error("WhatsApp Error", {
      component: "whatsapp.controller",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "Failed to process request. Please try again." });
  }
};

const fetchSegmentCustomers = async ({ schema, segment, branch_id }) => {
  const sixMonthsAgo = new Date();
  sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 6);
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const hasPhone = { [Op.and]: [{ [Op.ne]: null }, { [Op.ne]: "" }] };

  if (segment === "all") {
    const where = { phone: hasPhone };
    if (branch_id) where.branch_id = branch_id;
    return Customer.schema(schema).findAll({ where, attributes: ["id", "phone"] });
  }

  if (segment === "high_value_6m") {
    const rows = await sequelize.query(
      `SELECT customer_id FROM "${schema}".invoices WHERE created_at >= :sixMonthsAgo GROUP BY customer_id HAVING SUM(total_amount) >= 500`,
      { replacements: { sixMonthsAgo }, type: QueryTypes.SELECT },
    );
    const ids = Array.isArray(rows)
      ? rows.map((r) => r.customer_id).filter(Boolean)
      : [];
    if (ids.length === 0) return [];
    const where = { id: { [Op.in]: ids }, phone: hasPhone };
    if (branch_id) where.branch_id = branch_id;
    return Customer.schema(schema).findAll({ where, attributes: ["id", "phone"] });
  }

  if (segment === "inactive_6m") {
    const rows = await sequelize.query(
      `SELECT DISTINCT customer_id FROM "${schema}".invoices WHERE created_at >= :sixMonthsAgo`,
      { replacements: { sixMonthsAgo }, type: QueryTypes.SELECT },
    );
    const activeIds = Array.isArray(rows)
      ? rows.map((r) => r.customer_id).filter(Boolean)
      : [];
    const where = { phone: hasPhone };
    if (activeIds.length) where.id = { [Op.notIn]: activeIds };
    if (branch_id) where.branch_id = branch_id;
    return Customer.schema(schema).findAll({ where, attributes: ["id", "phone"] });
  }

  if (segment === "last_30d" || segment === "last_90d") {
    const since = segment === "last_30d" ? thirtyDaysAgo : ninetyDaysAgo;
    const rows = await sequelize.query(
      `SELECT DISTINCT customer_id FROM "${schema}".invoices WHERE created_at >= :since`,
      { replacements: { since }, type: QueryTypes.SELECT },
    );
    const ids = Array.isArray(rows)
      ? rows.map((r) => r.customer_id).filter(Boolean)
      : [];
    if (ids.length === 0) return [];
    const where = { id: { [Op.in]: ids }, phone: hasPhone };
    if (branch_id) where.branch_id = branch_id;
    return Customer.schema(schema).findAll({ where, attributes: ["id", "phone"] });
  }

  if (segment === "vip_only") {
    const where = { phone: hasPhone, type: "VIP" };
    if (branch_id) where.branch_id = branch_id;
    return Customer.schema(schema).findAll({ where, attributes: ["id", "phone"] });
  }

  return [];
};

export const sendBulk = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { segment, branch_id, message } = req.body;
    const tenantSlug = req.tenant.slug;

    let branchIdForCheck = branch_id ? Number.parseInt(branch_id, 10) : null;
    let waStatus = await resolveStatus(tenantSlug, branchIdForCheck);

    if (
      !branchIdForCheck &&
      waStatus.status !== "CONNECTED" &&
      !waStatus.is_ready
    ) {
      try {
        const Branch = sequelize.models.Branch;
        const branches = await Branch.schema(schema).findAll({
          attributes: ["id"],
          limit: 50,
        });
        for (const branch of branches) {
          const branchStatus = await resolveStatus(tenantSlug, branch.id);
          if (branchStatus.status === "CONNECTED" || branchStatus.is_ready) {
            branchIdForCheck = branch.id;
            waStatus = branchStatus;
            break;
          }
        }
      } catch (branchCheckError) {
        logger.warn("Failed to check branch connections for bulk send", {
          component: "whatsapp.controller",
          tenantSlug,
          error: branchCheckError?.message,
        });
      }
    }

    if (waStatus.status !== "CONNECTED" && !waStatus.is_ready) {
      return res.status(400).json({
        message: "WhatsApp is not connected. Connect WhatsApp first.",
      });
    }

    const customers = await fetchSegmentCustomers({ schema, segment, branch_id });
    if (customers.length === 0) {
      return res.json({
        success: true,
        sent: 0,
        queued: 0,
        total: 0,
        message: "No customers match segment.",
      });
    }

    const phones = [
      ...new Set(customers.map((c) => normalizePhone(c.phone || ""))),
    ].filter(Boolean);

    if (phones.length === 0) {
      return res.json({
        success: true,
        sent: 0,
        queued: 0,
        total: 0,
        message: "No phones to send to.",
      });
    }

    if (!isRedisEnabled()) {
      return res.status(503).json({
        message:
          "Bulk WhatsApp queue requires Redis to enforce daily limits and anti-ban pacing.",
      });
    }

    const targetBranchId = waStatus.is_central_fallback ? null : branchIdForCheck;
    const result = await enqueueBulkMessages({
      tenantSlug,
      branchId: targetBranchId,
      recipients: phones,
      message,
    });

    return res.status(202).json({
      success: true,
      queued: result.queued,
      sent: result.queued,
      total: phones.length,
      batchId: result.batchId,
      dailyLimit: result.limit,
      dailyUsed: result.used,
      dailyRemaining: result.remaining,
      isWarmup: result.isWarmup,
      warmupEndsAt: result.warmupEndsAt || null,
      estimatedMinutes: result.estimatedMinutes,
      message: `Queued ${result.queued} WhatsApp messages (~${result.estimatedMinutes} min background delivery; ${result.remaining} remaining today).`,
    });
  } catch (error) {
    if (error?.statusCode === 429) {
      return res.status(429).json({
        success: false,
        message: error.message,
        ...error.details,
      });
    }
    logger.error("WhatsApp sendBulk error", {
      component: "whatsapp.controller",
      error: error?.message,
      stack: error?.stack,
    });
    return res
      .status(500)
      .json({ message: "Failed to queue bulk messages. Please try again." });
  }
};
