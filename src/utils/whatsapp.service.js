import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import QRCode from "qrcode";
import path from "path";
import fs from "fs";
import { pino } from "pino";
import { Op } from "sequelize";
import WhatsappConfig from "../domains/platform/whatsapp.config.model.js";
import { formatPhoneForWhatsApp } from "./phone.utils.js";
import logger from "./logger.js";
import {
  cacheSet,
  cacheDelete,
  getRedisClient,
} from "../config/redis.js";
import {
  clearWhatsAppStatusCache,
  getSessionStatusFromStore,
  markWhatsAppPairedNow,
  publishWhatsAppStatusCache,
} from "./whatsapp-status.js";

const REDIS_SESSION_PREFIX = "whatsapp:session:";
const REDIS_SESSIONS_SET = "whatsapp:sessions:active";

const getRedisSessionKey = (sessionKey) =>
  `${REDIS_SESSION_PREFIX}${sessionKey}`;

const saveSessionToRedis = async (sessionKey, sessionData) => {
  try {
    await cacheSet(getRedisSessionKey(sessionKey), sessionData, 3600);
    const client = getRedisClient();
    if (client) {
      await client.sadd(REDIS_SESSIONS_SET, sessionKey);
    }
  } catch (error) {
    logger.warn("Failed to save session to Redis", {
      component: "whatsapp",
      sessionKey,
      error: error?.message,
    });
  }
};

const deleteSessionFromRedis = async (sessionKey) => {
  try {
    await cacheDelete(getRedisSessionKey(sessionKey));
    const client = getRedisClient();
    if (client) {
      await client.srem(REDIS_SESSIONS_SET, sessionKey);
    }
  } catch (error) {
    logger.warn("Failed to delete session from Redis", {
      component: "whatsapp",
      sessionKey,
      error: error?.message,
    });
  }
};

const sessions = new Map();

const getSessionsBaseDir = () =>
  process.env.WA_AUTH_DIR ||
  process.env.WHATSAPP_SESSIONS_DIR ||
  path.join(process.cwd(), "whatsapp_sessions");

const getSessionDir = (sessionKey) => path.join(getSessionsBaseDir(), sessionKey);

const getSessionKey = (tenantSlug, branchId = null) => {
  return branchId ? `${tenantSlug}_branch_${branchId}` : tenantSlug;
};

export const cleanupDisconnectedSessions = async () => {
  try {
    const disconnectedSessions = [];
    const allSessionKeys = new Set();

    try {
      const client = getRedisClient();
      if (client) {
        const redisSessions = await client.smembers(REDIS_SESSIONS_SET);
        redisSessions.forEach((key) => allSessionKeys.add(key));
      }
    } catch (redisError) {
      void redisError;
      logger.debug("Failed to get sessions from Redis, using memory only", {
        component: "whatsapp",
      });
    }

    sessions.forEach((_, key) => allSessionKeys.add(key));

    for (const sessionKey of allSessionKeys) {
      let isDisconnected = false;

      const sock = sessions.get(sessionKey);
      if (!sock || !sock.user) {
        isDisconnected = true;
      } else {

        const [tenantSlug, branchIdStr] = sessionKey.includes("_branch_")
          ? sessionKey.split("_branch_")
          : [sessionKey, null];
        const branchId = branchIdStr ? parseInt(branchIdStr) : null;

        const where = { tenant_slug: tenantSlug };
        if (branchId !== null && branchId !== undefined) {
          where.branch_id = branchId;
        } else {
          where.branch_id = { [Op.is]: null };
        }

        const config = await WhatsappConfig.findOne({ where });
        if (!config || config.session_status !== "CONNECTED") {
          isDisconnected = true;
        }
      }

      if (isDisconnected) {
        disconnectedSessions.push(sessionKey);
      }
    }

    for (const sessionKey of disconnectedSessions) {
      const sock = sessions.get(sessionKey);
      if (sock) {
        try {
          await sock.end();
        } catch (e) {
          logger.warn("Error ending socket during cleanup", {
            component: "whatsapp",
            sessionKey,
            error: e?.message,
          });
        }
      }
      sessions.delete(sessionKey);
      await deleteSessionFromRedis(sessionKey);
      logger.info("Cleaned up disconnected session", {
        component: "whatsapp",
        sessionKey,
      });
    }

    if (disconnectedSessions.length > 0) {
      logger.info("WhatsApp session cleanup completed", {
        component: "whatsapp",
        cleaned: disconnectedSessions.length,
        remaining: sessions.size,
      });
    }
  } catch (error) {
    logger.error("WhatsApp session cleanup error", {
      component: "whatsapp",
      error: error?.message,
    });
  }
};

export const refreshActiveSessionStatuses = async () => {
  for (const [sessionKey, sock] of sessions.entries()) {
    if (!sock?.user) continue;
    const branchMatch = /^(.*)_branch_(\d+)$/.exec(sessionKey);
    const tenantSlug = branchMatch ? branchMatch[1] : sessionKey;
    const branchId = branchMatch ? Number.parseInt(branchMatch[2], 10) : null;
    const uid = sock.user?.id;
    const phone = typeof uid === "string" ? uid.split(":")[0] : null;
    await publishWhatsAppStatusCache(tenantSlug, branchId, {
      status: "CONNECTED",
      is_ready: true,
      phone_connected: phone,
    });
  }
};

export const closeAllWhatsAppSockets = async () => {
  for (const [sessionKey, sock] of sessions.entries()) {
    try {
      sock?.end?.(new Error("Worker shutdown"));
    } catch {
      // Ignore socket close errors on shutdown
    }
    sessions.delete(sessionKey);
  }
};

export const getSessionStatus = async (tenantSlug, branchId = null) => {
  try {
    const normBranchId =
      branchId !== null && branchId !== undefined ? Number(branchId) : null;
    const sessionKey = getSessionKey(tenantSlug, normBranchId);
    const session = sessions.get(sessionKey);
    const uid = session?.user?.id;
    const phone = typeof uid === "string" ? uid.split(":")[0] : null;
    if (session?.user) {
      return {
        status: "CONNECTED",
        is_ready: true,
        phone_connected: phone || null,
        is_central_fallback: false,
      };
    }

    if (normBranchId !== null) {
      const centralKey = getSessionKey(tenantSlug, null);
      const centralSession = sessions.get(centralKey);
      const centralUid = centralSession?.user?.id;
      const centralPhone =
        typeof centralUid === "string" ? centralUid.split(":")[0] : null;
      if (centralSession?.user) {
        return {
          status: "CONNECTED",
          is_ready: true,
          phone_connected: centralPhone || null,
          is_central_fallback: true,
        };
      }
    }

    return await getSessionStatusFromStore(tenantSlug, normBranchId);
  } catch (e) {
    logger.warn("getSessionStatus error", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      error: e?.message,
    });
    return {
      status: "NOT_CONFIGURED",
      is_ready: false,
      phone_connected: null,
      is_central_fallback: false,
    };
  }
};

const VERSION_FETCH_TIMEOUT_MS = 15000;

const ensureWhatsappConfig = async (tenantSlug, branchId = null) => {
  try {
    const where = { tenant_slug: tenantSlug };
    if (branchId !== null && branchId !== undefined) {
      where.branch_id = branchId;
    } else {
      where.branch_id = { [Op.is]: null };
    }

    let config = await WhatsappConfig.findOne({ where });

    if (!config) {
      try {
        config = await WhatsappConfig.create({
          tenant_slug: tenantSlug,
          branch_id: branchId || null,
          session_status: "DISCONNECTED",
          is_enabled: false,
        });
      } catch (createErr) {
        config = await WhatsappConfig.findOne({ where });
        if (!config) throw createErr;
      }
    }

    return config;
  } catch (error) {
    logger.error("ensureWhatsappConfig error", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      error: error?.message,
      stack: error?.stack,
    });
    throw error;
  }
};

const safeUpdateConfig = async (
  tenantSlug,
  status,
  extra = {},
  branchId = null
) => {
  try {
    await ensureWhatsappConfig(tenantSlug, branchId);
    const where = { tenant_slug: tenantSlug };
    if (branchId !== null && branchId !== undefined) {
      where.branch_id = branchId;
    } else {
      where.branch_id = { [Op.is]: null };
    }
    await WhatsappConfig.update(
      { session_status: status, ...extra },
      { where }
    );
  } catch (e) {
    logger.warn("WhatsApp config update failed", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      status,
      error: e?.message,
    });
  }
};

const safeCallback = (socketCallback, payload) => {
  if (!socketCallback) return;
  try {
    socketCallback(payload);
  } catch (e) {
    logger.warn("WhatsApp socketCallback error", {
      component: "whatsapp",
      type: payload?.type,
      error: e?.message,
    });
  }
};

export const connectToWhatsApp = async (
  tenantSlug,
  socketCallback,
  options = {}
) => {
  const {
    isRestart = false,
    restartRetry = 0,
    branchId = null,
    wasQrPaired = false,
  } = options;
  const sessionKey = getSessionKey(tenantSlug, branchId);
  const log = (msg, ctx = {}) =>
    logger.info(msg, { component: "whatsapp", tenantSlug, branchId, ...ctx });
  const logErr = (msg, ctx = {}) =>
    logger.error(msg, { component: "whatsapp", tenantSlug, branchId, ...ctx });

  try {
    log("connectToWhatsApp start", { isRestart, restartRetry });

    const existingSock = sessions.get(sessionKey);
    if (existingSock) {
      try {
        await existingSock.end();
      } catch (e) {
        void e;
      }
      sessions.delete(sessionKey);
      await deleteSessionFromRedis(sessionKey);
    }

    const sessionDir = getSessionDir(sessionKey);
    await ensureWhatsappConfig(tenantSlug, branchId);

    if (!fs.existsSync(sessionDir)) {
      fs.mkdirSync(sessionDir, { recursive: true });
      log("session dir created", { sessionDir });
    }
    const authState = await useMultiFileAuthState(sessionDir);
    const { state, saveCreds } = authState;

    log("auth state loaded", { sessionDir });

    const versionPromise = fetchLatestBaileysVersion();
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error("Fetching Baileys version timed out")),
        VERSION_FETCH_TIMEOUT_MS
      );
    });
    const { version } = await Promise.race([versionPromise, timeoutPromise]).finally(() => {
      if (timeoutId) clearTimeout(timeoutId);
    });
    log("Baileys version fetched", {
      version: version?.join?.(".") || String(version),
    });

    const sock = makeWASocket({
      version,
      logger: pino({ level: "silent" }),
      printQRInTerminal: false,
      auth: state,
      getMessage: async () => undefined,
      browser: ["Chrome (Linux)", "Chrome", "120.0"],
      syncFullHistory: false,
    });
    log("makeWASocket created");

    sessions.set(sessionKey, sock);

    await saveSessionToRedis(sessionKey, {
      tenantSlug,
      branchId,
      connected: true,
      timestamp: Date.now(),
    });

    await saveSessionToRedis(sessionKey, {
      tenantSlug,
      branchId,
      connected: true,
      timestamp: Date.now(),
    });

    sock.ev.on("creds.update", (...args) => {
      try {
        saveCreds(...args);
      } catch (e) {
        logger.warn("saveCreds error", {
          component: "whatsapp",
          error: e?.message,
        });
      }
    });

    let hasConnected = false;
    let sawQrInAttempt = false;

    sock.ev.on("connection.update", async (update) => {
      try {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          sawQrInAttempt = true;
          log("QR received, generating data URL");
          try {
            const qrCodeDataUrl = await QRCode.toDataURL(qr);
            safeCallback(socketCallback, { type: "qr", data: qrCodeDataUrl });
            log("QR data URL sent to client");
          } catch (e) {
            logErr("QR toDataURL failed", { error: e?.message });
          }
          return;
        }

        if (connection === "close") {
          const statusCode = lastDisconnect?.error?.output?.statusCode;
          const errMsg = lastDisconnect?.error?.message || "";
          const errPayload = lastDisconnect?.error
            ? JSON.stringify(lastDisconnect.error).slice(0, 500)
            : "";
          log("connection.update close", {
            statusCode,
            hasConnected,
            isRestart,
            restartRetry,
            errMsg,
            errPayload,
          });

          await safeUpdateConfig(tenantSlug, "DISCONNECTED", {}, branchId);
          await clearWhatsAppStatusCache(tenantSlug, branchId);

          const isRestartRequired =
            statusCode === DisconnectReason.restartRequired;
          const isLoggedOut = statusCode === DisconnectReason.loggedOut;
          const isReplaced = statusCode === DisconnectReason.connectionReplaced;

          if (isRestartRequired) {
            log(
              "restartRequired (515): QR scanned, restarting with saved creds"
            );
            sessions.delete(sessionKey);
            await deleteSessionFromRedis(sessionKey);
            safeCallback(socketCallback, {
              type: "restarting",
              data: "Linking device…",
            });
            const doRestart = () =>
              connectToWhatsApp(tenantSlug, socketCallback, {
                isRestart: true,
                restartRetry: 0,
                branchId,
                wasQrPaired: sawQrInAttempt || wasQrPaired,
              }).catch((err) => {
                logErr("restart after QR failed", {
                  error: err?.message,
                  stack: err?.stack,
                });
                safeCallback(socketCallback, {
                  type: "error",
                  data: err?.message || "Restart failed. Try Connect again.",
                });
              });
            setTimeout(doRestart, 800);
            return;
          }

          if (isLoggedOut || isReplaced) {
            try {
              if (fs.existsSync(sessionDir))
                fs.rmSync(sessionDir, { recursive: true, force: true });
            } catch (cleanupError) {
              logErr("Session cleanup failed", {
                error: cleanupError?.message,
              });
            }
            sessions.delete(sessionKey);
            await deleteSessionFromRedis(sessionKey);

            if (!hasConnected && socketCallback) {
              log("Invalid session cleared, generating new QR code automatically");
              safeCallback(socketCallback, {
                type: "restarting",
                data: "Generating new QR...",
              });
              const doFreshStart = () =>
                connectToWhatsApp(tenantSlug, socketCallback, {
                  isRestart: false,
                  restartRetry: 0,
                  branchId,
                }).catch((err) => {
                  logErr("Fresh QR restart failed", { error: err?.message });
                  safeCallback(socketCallback, {
                    type: "error",
                    data: err?.message || "Failed to generate QR code.",
                  });
                });
              setTimeout(doFreshStart, 500);
              return;
            }

            const msg = isReplaced
              ? "This device was linked from another client. Scan QR again to use this one."
              : errMsg || "Logged out. Scan QR again to connect.";
            safeCallback(socketCallback, { type: "closed", data: msg });
            return;
          }

          if (hasConnected) {
            log("session dropped (was connected), reconnecting");
            sessions.delete(sessionKey);
            await deleteSessionFromRedis(sessionKey);
            connectToWhatsApp(tenantSlug, socketCallback, { branchId }).catch(
              (err) => {
                logErr("reconnect failed", { error: err?.message });
                safeCallback(socketCallback, {
                  type: "error",
                  data: err?.message || "Reconnect failed.",
                });
              }
            );
            return;
          }

          if (isRestart && restartRetry < 1) {
            log("restart socket closed before open, retrying once");
            sessions.delete(sessionKey);
            await deleteSessionFromRedis(sessionKey);
            const doRetry = () =>
              connectToWhatsApp(tenantSlug, socketCallback, {
                isRestart: true,
                restartRetry: 1,
                branchId,
              }).catch((err) => {
                logErr("restart retry failed", { error: err?.message });
                safeCallback(socketCallback, {
                  type: "error",
                  data: err?.message || "Restart failed. Try Connect again.",
                });
              });
            setTimeout(doRetry, 500);
            return;
          }

          log(
            "connection closed during pairing (no open yet), not reconnecting"
          );
          const msg =
            errMsg ||
            `Connection closed (${
              statusCode ?? "unknown"
            }). Scan QR again to connect.`;
          safeCallback(socketCallback, { type: "closed", data: msg });
          return;
        }

        if (connection === "open") {
          hasConnected = true;
          const uid = sock.user?.id;
          const phoneConnected = typeof uid === "string" ? uid.split(":")[0] : null;
          log("connection open", { user: uid });
          await safeUpdateConfig(
            tenantSlug,
            "CONNECTED",
            { last_active: new Date() },
            branchId
          );
          if (sawQrInAttempt || wasQrPaired) {
            await markWhatsAppPairedNow(tenantSlug, branchId);
          }
          await publishWhatsAppStatusCache(tenantSlug, branchId, {
            status: "CONNECTED",
            is_ready: true,
            phone_connected: phoneConnected,
          });
          safeCallback(socketCallback, { type: "connected", user: sock.user });
        } else if (connection) {
          log("connection.update other", { connection });
        }
      } catch (handlerErr) {
        logErr("connection.update handler error", {
          error: handlerErr?.message,
          stack: handlerErr?.stack,
        });
        try {
          safeCallback(socketCallback, {
            type: "error",
            data: handlerErr?.message || "Connection error.",
          });
        } catch (callbackError) {
          logErr("Failed to send error callback", {
            error: callbackError?.message,
          });
        }
      }
    });

    log("connectToWhatsApp setup done, returning sock");
    return sock;
  } catch (error) {
    logErr("connectToWhatsApp error", {
      error: error?.message,
      stack: error?.stack,
    });
    throw error;
  }
};

export const resolveConfigAndSocket = async (tenantSlug, branchId = null) => {
  const normBranchId =
    branchId !== null && branchId !== undefined ? Number(branchId) : null;

  // 1. If branchId was requested, check branch-specific session first
  if (normBranchId !== null) {
    const branchKey = getSessionKey(tenantSlug, normBranchId);
    let branchSock = sessions.get(branchKey);
    const branchConfig = await WhatsappConfig.findOne({
      where: { tenant_slug: tenantSlug, branch_id: normBranchId },
    });

    if (branchConfig && branchConfig.session_status === "CONNECTED") {
      if (!branchSock || !branchSock.user) {
        logger.info("Branch socket not in memory, attempting reconnect", {
          component: "whatsapp",
          tenantSlug,
          branchId: normBranchId,
          branchKey,
        });
        try {
          await connectToWhatsApp(tenantSlug, null, { branchId: normBranchId });
          await new Promise((r) => setTimeout(r, 2000));
          branchSock = sessions.get(branchKey);
        } catch (reconnErr) {
          logger.warn("Branch WhatsApp socket reconnect attempt failed", {
            component: "whatsapp",
            tenantSlug,
            branchId: normBranchId,
            error: reconnErr?.message,
          });
        }
      }
      if (branchSock && branchSock.user) {
        return {
          sock: branchSock,
          config: branchConfig,
          sessionKey: branchKey,
          branchId: normBranchId,
          isFallback: false,
        };
      }
    }
  }

  // 2. Fallback to store-level central session (branch_id: null)
  const centralKey = getSessionKey(tenantSlug, null);
  let centralSock = sessions.get(centralKey);
  const centralConfig = await WhatsappConfig.findOne({
    where: { tenant_slug: tenantSlug, branch_id: { [Op.is]: null } },
  });

  if (centralConfig && centralConfig.session_status === "CONNECTED") {
    if (!centralSock || !centralSock.user) {
      logger.info("Central socket not in memory, attempting reconnect", {
        component: "whatsapp",
        tenantSlug,
        centralKey,
      });
      try {
        await connectToWhatsApp(tenantSlug, null, { branchId: null });
        await new Promise((r) => setTimeout(r, 2000));
        centralSock = sessions.get(centralKey);
      } catch (reconnErr) {
        logger.warn("Central WhatsApp socket reconnect attempt failed", {
          component: "whatsapp",
          tenantSlug,
          error: reconnErr?.message,
        });
      }
    }
    if (centralSock && centralSock.user) {
      return {
        sock: centralSock,
        config: centralConfig,
        sessionKey: centralKey,
        branchId: null,
        isFallback: normBranchId !== null,
      };
    }
  }

  return null;
};

export const sendInvoicePDF = async (
  tenantSlug,
  targetPhone,
  pdfPath,
  caption = "",
  branchId = null
) => {
  try {
    const resolved = await resolveConfigAndSocket(tenantSlug, branchId);
    if (!resolved) {
      logger.info("WhatsApp not connected for PDF send", {
        component: "whatsapp",
        tenantSlug,
        branchId,
      });
      return false;
    }

    const { sock, sessionKey, isFallback } = resolved;
    const formattedPhone = formatPhoneForWhatsApp(targetPhone);
    if (!formattedPhone) {
      logger.warn("Invalid phone format for PDF send", {
        component: "whatsapp",
        tenantSlug,
        branchId,
        targetPhone,
      });
      return false;
    }

    if (fs.existsSync(pdfPath)) {
      const pdfBuffer = fs.readFileSync(pdfPath);
      const fileName = path.basename(pdfPath);

      logger.info("Sending PDF via WhatsApp", {
        component: "whatsapp",
        tenantSlug,
        branchId,
        sessionKey,
        isFallback,
        targetPhone: formattedPhone.replace(/@.*/, "@***"),
        fileName,
        fileSize: pdfBuffer.length,
      });

      await sock.sendMessage(formattedPhone, {
        document: pdfBuffer,
        mimetype: "application/pdf",
        fileName: fileName,
        caption: caption,
      });

      logger.info("PDF sent successfully via WhatsApp", {
        component: "whatsapp",
        tenantSlug,
        branchId,
        sessionKey,
        targetPhone: formattedPhone.replace(/@.*/, "@***"),
      });

      return true;
    } else {
      logger.warn("PDF file not found for WhatsApp send", {
        component: "whatsapp",
        pdfPath,
        tenantSlug,
        branchId,
      });
      return false;
    }
  } catch (error) {
    logger.error("Send PDF error", {
      component: "whatsapp",
      error: error?.message,
      stack: error?.stack,
    });
    return false;
  }
};

export const getSocket = (tenantSlug, branchId = null) => {
  const normBranchId =
    branchId !== null && branchId !== undefined ? Number(branchId) : null;
  const sessionKey = getSessionKey(tenantSlug, normBranchId);
  let sock = sessions.get(sessionKey);

  if ((!sock || !sock.user) && normBranchId !== null) {
    const centralKey = getSessionKey(tenantSlug, null);
    const centralSock = sessions.get(centralKey);
    if (centralSock && centralSock.user) {
      return centralSock;
    }
  }

  if (!sock) {
    logger.warn("Socket not found in sessions", {
      component: "whatsapp",
      tenantSlug,
      branchId: normBranchId,
      sessionKey,
      availableSessions: Array.from(sessions.keys()),
    });
    return null;
  }

  if (!sock.user) {
    logger.warn("Socket exists but user not authenticated", {
      component: "whatsapp",
      tenantSlug,
      branchId: normBranchId,
      sessionKey,
      socketExists: true,
      hasUser: false,
    });
    return null;
  }

  logger.info("Socket found and ready", {
    component: "whatsapp",
    tenantSlug,
    branchId: normBranchId,
    sessionKey,
    userId: sock.user?.id,
  });

  return sock;
};

const formatPhoneJid = (phone) => {
  return formatPhoneForWhatsApp(phone);
};

export const sendWhatsAppText = async (
  tenantSlug,
  targetPhone,
  text,
  branchId = null
) => {
  try {
    const resolved = await resolveConfigAndSocket(tenantSlug, branchId);
    if (!resolved) {
      logger.info("WhatsApp not connected for text send", {
        component: "whatsapp",
        tenantSlug,
        branchId,
      });
      return false;
    }

    const { sock, sessionKey, isFallback } = resolved;
    const jid = formatPhoneJid(targetPhone);
    if (!jid) {
      logger.warn("Invalid phone format for WhatsApp send", {
        component: "whatsapp",
        tenantSlug,
        branchId,
        targetPhone:
          targetPhone.substring(0, 4) +
          "****" +
          targetPhone.substring(targetPhone.length - 2),
      });
      return false;
    }

    logger.info("Sending WhatsApp message", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      sessionKey,
      isFallback,
      jid: jid.replace(/@.*/, "@***"),
      messageLength: text?.length || 0,
    });

    await sock.sendMessage(jid, { text: text || "" });

    logger.info("WhatsApp message sent successfully", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      sessionKey,
      jid: jid.replace(/@.*/, "@***"),
    });

    return true;
  } catch (error) {
    logger.error("Send WhatsApp text error", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      targetPhone:
        targetPhone.substring(0, 4) +
        "****" +
        targetPhone.substring(targetPhone.length - 2),
      error: error?.message,
      stack: error?.stack,
    });
    return false;
  }
};

export const sendWhatsAppDocument = async (
  tenantSlug,
  targetPhone,
  buffer,
  fileName,
  caption = "",
  branchId = null
) => {
  try {
    const resolved = await resolveConfigAndSocket(tenantSlug, branchId);
    if (!resolved) {
      logger.info("WhatsApp not connected for document send", {
        component: "whatsapp",
        tenantSlug,
        branchId,
      });
      return false;
    }

    const { sock, sessionKey, isFallback } = resolved;
    const jid = formatPhoneJid(targetPhone);
    if (!jid) {
      logger.warn("Invalid phone format for WhatsApp document send", {
        component: "whatsapp",
        tenantSlug,
        branchId,
        targetPhone,
      });
      return false;
    }

    if (!buffer || !Buffer.isBuffer(buffer)) {
      logger.error("Invalid buffer provided for WhatsApp document", {
        component: "whatsapp",
        tenantSlug,
        branchId,
        bufferType: typeof buffer,
        isBuffer: Buffer.isBuffer(buffer),
      });
      return false;
    }

    logger.info("Sending document via WhatsApp", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      sessionKey,
      isFallback,
      targetPhone: jid.replace(/@.*/, "@***"),
      fileName,
      bufferSize: buffer.length,
    });

    await sock.sendMessage(jid, {
      document: buffer,
      mimetype: "application/pdf",
      fileName: fileName || "invoice.pdf",
      caption: caption || "",
    });

    logger.info("Document sent successfully via WhatsApp", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      sessionKey,
      targetPhone: jid.replace(/@.*/, "@***"),
    });

    return true;
  } catch (error) {
    logger.error("Send WhatsApp document error", {
      component: "whatsapp",
      error: error?.message,
      stack: error?.stack,
      tenantSlug,
      branchId,
    });
    return false;
  }
};

export const logoutWhatsApp = async (tenantSlug, branchId = null) => {
  try {
    const sessionKey = getSessionKey(tenantSlug, branchId);
    const sock = sessions.get(sessionKey);
    if (sock) {
      try {
        await sock.logout();
      } catch {
        try {
          await sock.end(new Error("Manual logout"));
        } catch {
          // ignore
        }
      }
      sessions.delete(sessionKey);
      await deleteSessionFromRedis(sessionKey);
    }

    const sessionDir = getSessionDir(sessionKey);
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    await clearWhatsAppStatusCache(tenantSlug, branchId);
    await ensureWhatsappConfig(tenantSlug, branchId);
    const where = { tenant_slug: tenantSlug };
    if (branchId !== null && branchId !== undefined) {
      where.branch_id = branchId;
    } else {
      where.branch_id = { [Op.is]: null };
    }
    await WhatsappConfig.update({ session_status: "DISCONNECTED" }, { where });

    return true;
  } catch (error) {
    logger.error("WhatsApp logout error", {
      component: "whatsapp",
      tenantSlug,
      branchId,
      error: error?.message,
    });
    return false;
  }
};
