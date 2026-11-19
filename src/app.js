import "./config/env.js";
import express from "express";
import http from "http";
import cors from "cors";
import compression from "compression";
import rateLimit from "express-rate-limit";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import path from "path";

import { fileURLToPath } from "url";
import sequelize from "./config/database.js";
import logger from "./utils/logger.js";

process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  logger.error("unhandledRejection", {
    component: "process",
    error: err?.message,
    stack: err?.stack,
  });

  if (process.env.NODE_ENV === "production") {
    logger.error("Exiting due to unhandled rejection in production");
    process.exit(1);
  }
});
process.on("uncaughtException", (err) => {
  logger.error("uncaughtException", {
    component: "process",
    error: err?.message,
    stack: err?.stack,
  });

  logger.error("Exiting due to uncaught exception");
  process.exit(1);
});

import { requestId } from "./middlewares/requestId.middleware.js";
import { resolveTenant } from "./middlewares/tenant.middleware.js";
import { protect } from "./middlewares/auth.middleware.js";
import sanitizeInput from "./middlewares/sanitize.middleware.js";
import { initSocket } from "./config/socket.js";
import { closeWhatsAppQueues } from "./queues/whatsapp.queue.js";

import adminRoutes from "./domains/admin/admin.routes.js";
import platformRoutes from "./domains/platform/platform.routes.js";
import authRoutes from "./domains/auth/auth.routes.js";
import whatsappRoutes from "./domains/platform/whatsapp.routes.js";
import inventoryRoutes from "./domains/inventory/inventory.routes.js";
import customerRoutes from "./domains/customers/customer.routes.js";
import salesRoutes from "./domains/sales/sales.routes.js";
import refundRoutes from "./domains/sales/refund.routes.js";
import managementRoutes from "./domains/management/management.routes.js";
import dashboardRoutes from "./domains/dashboard/dashboard.routes.js";

import Tenant from "./domains/platform/tenant.model.js";
import WhatsappConfig from "./domains/platform/whatsapp.config.model.js";
import ContactMessage from "./domains/platform/contact-message.model.js";
import "./domains/associations.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);

const trustProxyRaw = process.env.TRUST_PROXY;
const trustProxyValue =
  trustProxyRaw === undefined
    ? 1
    : trustProxyRaw === "true"
      ? true
      : trustProxyRaw === "false"
        ? false
        : Number.isNaN(Number(trustProxyRaw))
          ? trustProxyRaw
          : Number(trustProxyRaw);
app.set("trust proxy", trustProxyValue);

initSocket(httpServer);

const defaultOrigins = [
  "http://localhost:5173",
  "http://localhost:3000",
];

const corsOrigins = process.env.CORS_ORIGINS
  ? [
      ...process.env.CORS_ORIGINS.split(",")
        .map((o) => o.trim().replace(/\/$/, ""))
        .filter(Boolean),
      ...defaultOrigins,
    ]
  : defaultOrigins;
app.use(
  cors({
    origin: corsOrigins,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "x-tenant-id"],
    exposedHeaders: [
      "x-subscription-warning",
      "x-subscription-expiring-soon",
      "x-subscription-expires-at",
      "x-subscription-grace-ends-at",
      "x-subscription-readonly",
    ],
  })
);

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: "cross-origin" },
  })
);

app.use(express.json());
app.use(cookieParser());

app.use(sanitizeInput);
app.use(
  compression({
    filter: (req, res) => {
      if (req.originalUrl?.startsWith("/api/whatsapp/connect")) return false;
      return compression.filter(req, res);
    },
  })
);
app.use(requestId);

const apiLimiter = rateLimit({
  windowMs: Number(process.env.API_RATE_LIMIT_WINDOW_MS) || 1 * 60 * 1000,
  max: Number(process.env.API_RATE_LIMIT_MAX) || 500,
  message: {
    success: false,
    message: "Too many requests. Please try again later.",
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {

    const path = req.path || req.originalUrl || "";
    return path === "/health" || path === "/api/health" || path === "/ping";
  },
});
app.use("/api", apiLimiter);

app.use("/uploads", express.static(path.join(__dirname, "../public/uploads")));

app.get("/ping", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
});

app.get("/health", async (req, res) => {
  const checks = {
    database: false,
    whatsapp: false,
  };

  try {
    await sequelize.authenticate();
    checks.database = true;
  } catch (e) {
    logger.error("Database health check failed", {
      requestId: req.requestId,
      error: e?.message,
    });
  }

  try {
    const whatsappConfigs = await WhatsappConfig.findAll({ limit: 1 });
    checks.whatsapp = whatsappConfigs.length > 0;
  } catch (e) {
    logger.warn("WhatsApp health check failed", {
      requestId: req.requestId,
      error: e?.message,
    });
  }

  const allHealthy = checks.database;
  const status = allHealthy ? "ok" : "degraded";

  res.status(allHealthy ? 200 : 503).json({
    status,
    checks,
    timestamp: new Date().toISOString(),
  });
});

app.get("/api/health", async (req, res) => {
  try {
    await sequelize.authenticate();
    res.status(200).json({
      status: "ok",
      timestamp: new Date().toISOString(),
    });
  } catch (e) {
    logger.error("API health check failed", {
      requestId: req.requestId,
      error: e?.message,
    });
    res.status(503).json({
      status: "error",
      message: "Database connection failed",
    });
  }
});


app.use("/api/admin", adminRoutes);
app.use("/api/platform", platformRoutes);
app.use("/api/auth", resolveTenant, authRoutes);
app.use("/api/whatsapp", whatsappRoutes);

app.use("/api/inventory", resolveTenant, protect, inventoryRoutes);
app.use("/api/customers", resolveTenant, protect, customerRoutes);
app.use("/api/sales", resolveTenant, protect, salesRoutes);
app.use("/api/refunds", resolveTenant, protect, refundRoutes);
app.use("/api/manage", resolveTenant, protect, managementRoutes);
app.use("/api/dashboard", resolveTenant, protect, dashboardRoutes);

app.use((err, req, res, next) => {

  if (res.headersSent) {
    return next(err);
  }

  const isValidation = err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError';

  if (!isValidation) {
    logger.error("Unhandled error", {
      requestId: req.requestId,
      error: err?.message || String(err),
      stack: err?.stack,
      path: req.path,
      method: req.method,
      tenant: req.tenant?.slug,
    });
  } else {
    logger.debug("Validation error", {
      requestId: req.requestId,
      error: err?.message,
    });
  }

  if (req.requestId) {
    res.setHeader("x-request-id", req.requestId);
  }

  const statusCode = err.statusCode || err.status || 500;

  res.status(statusCode).json({
    success: false,
    message: err.message || "Internal server error. Please try again later.",
    ...(process.env.NODE_ENV === "development" && {
      error: err.message,
      stack: err.stack,
    }),
  });
});

const SHUTDOWN_GRACE_MS = 10_000;
let isShuttingDown = false;

const gracefulShutdown = async (signal) => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info("Shutdown signal received", { component: "shutdown", signal });

  const forceExit = () => {
    logger.warn("Forcing exit after grace period", { component: "shutdown" });
    process.exit(1);
  };
  const timer = setTimeout(forceExit, SHUTDOWN_GRACE_MS);

  try {
    await new Promise((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else {
          logger.info("HTTP server closed", { component: "shutdown" });
          resolve();
        }
      });
    });
    await closeWhatsAppQueues();
    await sequelize.close();
    logger.info("Database connection closed", { component: "shutdown" });
    clearTimeout(timer);
    process.exit(0);
  } catch (err) {
    logger.error("Shutdown error", {
      component: "shutdown",
      error: err?.message,
    });
    clearTimeout(timer);
    process.exit(1);
  }
};

const startServer = async () => {

  try {
    await sequelize.authenticate();
    logger.info("PostgreSQL connection established", { component: "startup" });

    await sequelize.query("SET search_path TO public");
    await Tenant.sync({ alter: true });
    await WhatsappConfig.sync({ alter: true });
    await ContactMessage.sync({ alter: true });
    logger.info("Platform tables synced (public schema)", {
      component: "startup",
    });

    logger.info("Startup schema loop skipped (use `npm run db:migrate` for tenant DDL)", {
      component: "startup",
    });
  } catch (dbError) {

    logger.error("Database connection failed during startup", {
      component: "startup",
      error: dbError.message,
      stack: dbError.stack,
    });

    if (process.env.REQUIRE_DB === "true") {
      logger.error("REQUIRE_DB=true set, exiting due to DB failure");
      process.exit(1);
    } else {
      logger.warn(
        "Starting server without database connection (REQUIRE_DB not set)"
      );
      logger.warn(
        "API endpoints requiring database will fail until DB is available"
      );
    }
  }

  try {

    const PORT = process.env.PORT || 5000;
    httpServer.listen(PORT, "0.0.0.0", () => {
      logger.info("Server listening", { component: "startup", port: PORT });
      process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
      process.on("SIGINT", () => gracefulShutdown("SIGINT"));
    });
  } catch (serverError) {
    logger.error("Failed to start HTTP server", {
      component: "startup",
      error: serverError.message,
      stack: serverError.stack,
    });
    process.exit(1);
  }
};

if (process.env.NODE_ENV !== "test") {
  startServer();
}

export { app };
