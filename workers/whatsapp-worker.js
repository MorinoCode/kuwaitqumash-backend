import "../src/config/env.js";
import { Op } from "sequelize";
import { DelayedError, Worker } from "bullmq";
import sequelize from "../src/config/database.js";
import { isRedisEnabled } from "../src/config/redis.js";
import Tenant from "../src/domains/platform/tenant.model.js";
import Branch from "../src/domains/store/branch.model.js";
import WhatsappConfig from "../src/domains/platform/whatsapp.config.model.js";
import {
  WA_BULK_QUEUE,
  WA_CMD_CHANNEL,
  WA_TRANSACTIONAL_QUEUE,
  createBullRedisConnection,
  getKuwaitHour,
  getQuietHoursBounds,
  getSessionKey,
  getWaEventChannel,
  snapToKuwaitAllowedWindow,
} from "../src/queues/whatsapp.queue.js";
import * as whatsappService from "../src/utils/whatsapp.service.js";
import logger from "../src/utils/logger.js";

const STAGGER_DELAY_MS =
  Math.max(500, Number.parseInt(process.env.WA_RECONNECT_STAGGER_MS || "2000", 10) || 2000);
const HEARTBEAT_INTERVAL_MS = 45 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let transactionalWorker = null;
let bulkWorker = null;
let cmdSubscriber = null;
let evtPublisher = null;
let heartbeatTimer = null;
let cleanupTimer = null;
let isShuttingDown = false;

const reconnectAllSessionsStaggered = async () => {
  try {
    const configs = await WhatsappConfig.findAll({
      where: { session_status: "CONNECTED" },
      order: [["id", "ASC"]],
    });

    if (configs.length === 0) {
      logger.info("No CONNECTED WhatsApp sessions to restore on boot", {
        component: "whatsapp-worker",
      });
      return;
    }

    const tenants = await Tenant.findAll({
      where: { subscription_status: "active" },
      attributes: ["slug", "db_schema"],
    });
    const activeSlugs = new Set(tenants.map((t) => t.slug));

    logger.info("Starting staggered WhatsApp reconnect", {
      component: "whatsapp-worker",
      count: configs.length,
      staggerMs: STAGGER_DELAY_MS,
    });

    let index = 0;
    for (const cfg of configs) {
      if (isShuttingDown) break;
      if (!activeSlugs.has(cfg.tenant_slug)) continue;

      if (index > 0) {
        const jitter = Math.floor(Math.random() * 500);
        await sleep(STAGGER_DELAY_MS + jitter);
      }
      index += 1;

      try {
        await Promise.race([
          whatsappService.connectToWhatsApp(cfg.tenant_slug, null, {
            branchId: cfg.branch_id ?? null,
          }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error("Reconnect timeout")), 30000),
          ),
        ]);
      } catch (err) {
        logger.warn("Staggered WhatsApp reconnect failed for session", {
          component: "whatsapp-worker",
          tenantSlug: cfg.tenant_slug,
          branchId: cfg.branch_id ?? null,
          error: err?.message,
        });
      }
    }

    // Load Branch model cleanly so associations remain warm if referenced later
    void Branch;
  } catch (error) {
    logger.error("Failed staggered WhatsApp reconnect", {
      component: "whatsapp-worker",
      error: error?.message,
    });
  }
};

const setupCommandSubscriber = async () => {
  cmdSubscriber = createBullRedisConnection();
  evtPublisher = createBullRedisConnection();
  if (!cmdSubscriber || !evtPublisher) {
    throw new Error("Redis connection unavailable for whatsapp-worker");
  }

  cmdSubscriber.on("error", (err) => {
    logger.warn("WhatsApp worker command subscriber error", {
      component: "whatsapp-worker",
      error: err?.message,
    });
  });
  evtPublisher.on("error", (err) => {
    logger.warn("WhatsApp worker event publisher error", {
      component: "whatsapp-worker",
      error: err?.message,
    });
  });

  await cmdSubscriber.subscribe(WA_CMD_CHANNEL);
  cmdSubscriber.on("message", async (channel, rawMessage) => {
    if (channel !== WA_CMD_CHANNEL) return;

    let cmd;
    try {
      cmd = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const { action, tenantSlug, branchId = null } = cmd || {};
    if (!tenantSlug) return;
    const sessionKey = getSessionKey(tenantSlug, branchId);
    const evtChannel = getWaEventChannel(sessionKey);

    const publishEvent = (evt) => {
      evtPublisher
        ?.publish(evtChannel, JSON.stringify(evt))
        .catch((err) =>
          logger.debug("Failed to publish WhatsApp worker event", {
            component: "whatsapp-worker",
            sessionKey,
            error: err?.message,
          }),
        );
    };

    try {
      if (action === "connect") {
        await whatsappService.connectToWhatsApp(tenantSlug, publishEvent, {
          branchId,
        });
      } else if (action === "disconnect") {
        const ok = await whatsappService.logoutWhatsApp(tenantSlug, branchId);
        publishEvent({ type: "disconnected", data: ok });
      }
    } catch (error) {
      logger.error("WhatsApp worker command failed", {
        component: "whatsapp-worker",
        action,
        sessionKey,
        error: error?.message,
      });
      publishEvent({
        type: "error",
        data: error?.message || "WhatsApp command failed",
      });
    }
  });
};

const setupBullWorkers = () => {
  const transactionalConn = createBullRedisConnection();
  const bulkConn = createBullRedisConnection();

  if (!transactionalConn || !bulkConn) {
    throw new Error("Redis is required to start BullMQ WhatsApp workers.");
  }

  transactionalWorker = new Worker(
    WA_TRANSACTIONAL_QUEUE,
    async (job) => {
      const { tenantSlug, phone, pdfBase64, fileName, caption, branchId = null } =
        job.data;
      const pdfBuffer = Buffer.from(pdfBase64, "base64");
      const ok = await whatsappService.sendWhatsAppDocument(
        tenantSlug,
        phone,
        pdfBuffer,
        fileName,
        caption,
        branchId,
      );
      if (!ok) {
        throw new Error(
          `Failed to deliver invoice PDF to customer for ${tenantSlug}`,
        );
      }
      return { delivered: true };
    },
    {
      connection: transactionalConn,
      concurrency: 1,
      limiter: { max: 1, duration: 2500 },
    },
  );

  transactionalWorker.on("failed", (job, err) => {
    logger.warn("Transactional WhatsApp job failed", {
      component: "whatsapp-worker",
      jobId: job?.id,
      tenantSlug: job?.data?.tenantSlug,
      attemptsMade: job?.attemptsMade,
      error: err?.message,
    });
  });

  bulkWorker = new Worker(
    WA_BULK_QUEUE,
    async (job, token) => {
      const { startHour, endHour } = getQuietHoursBounds();
      const nowMs = Date.now();
      const kuwaitHour = getKuwaitHour(nowMs);
      if (kuwaitHour < startHour || kuwaitHour >= endHour) {
        const jitterSec = Math.floor(Math.random() * 180);
        const nextAllowedMs = snapToKuwaitAllowedWindow(
          nowMs,
          { startHour, endHour },
          jitterSec,
        );
        await job.moveToDelayed(nextAllowedMs, token);
        throw new DelayedError();
      }

      const { tenantSlug, phone, message, branchId = null } = job.data;
      const ok = await whatsappService.sendWhatsAppText(
        tenantSlug,
        phone,
        message,
        branchId,
      );
      if (!ok) {
        throw new Error(`Bulk message send failed for ${tenantSlug}`);
      }
      return { delivered: true };
    },
    {
      connection: bulkConn,
      concurrency: 1,
    },
  );

  bulkWorker.on("failed", (job, err) => {
    logger.warn("Bulk WhatsApp job failed", {
      component: "whatsapp-worker",
      jobId: job?.id,
      tenantSlug: job?.data?.tenantSlug,
      attemptsMade: job?.attemptsMade,
      error: err?.message,
    });
  });
};

const shutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info("WhatsApp worker shutting down", {
    component: "whatsapp-worker",
    signal,
  });

  if (heartbeatTimer) clearInterval(heartbeatTimer);
  if (cleanupTimer) clearInterval(cleanupTimer);

  try {
    await Promise.all([
      transactionalWorker?.close().catch(() => {}),
      bulkWorker?.close().catch(() => {}),
      cmdSubscriber?.unsubscribe().catch(() => {}),
    ]);
    await Promise.all([
      cmdSubscriber?.quit().catch(() => {}),
      evtPublisher?.quit().catch(() => {}),
    ]);
    await whatsappService.closeAllWhatsAppSockets().catch(() => {});
    await sequelize.close().catch(() => {});
  } finally {
    process.exit(0);
  }
};

const start = async () => {
  if (!isRedisEnabled()) {
    logger.error(
      "REDIS_ENABLED=true and REDIS_URL are required to run whatsapp-worker.",
      { component: "whatsapp-worker" },
    );
    process.exit(1);
  }

  await sequelize.authenticate();
  await sequelize.query("SET search_path TO public");
  await WhatsappConfig.sync({ alter: false });

  await setupCommandSubscriber();
  setupBullWorkers();

  heartbeatTimer = setInterval(() => {
    whatsappService.refreshActiveSessionStatuses().catch(() => {});
  }, HEARTBEAT_INTERVAL_MS);

  cleanupTimer = setInterval(() => {
    whatsappService.cleanupDisconnectedSessions().catch((err) => {
      logger.warn("WhatsApp session cleanup failed", {
        component: "whatsapp-worker",
        error: err?.message,
      });
    });
  }, CLEANUP_INTERVAL_MS);

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  logger.info("WhatsApp worker started cleanly", {
    component: "whatsapp-worker",
  });

  // Restore active sessions in the background with staggered delays
  void Op;
  void reconnectAllSessionsStaggered();
};

start().catch((error) => {
  logger.error("WhatsApp worker failed to start", {
    component: "whatsapp-worker",
    error: error?.message,
    stack: error?.stack,
  });
  process.exit(1);
});

