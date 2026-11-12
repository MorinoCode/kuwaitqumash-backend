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
import { ensureTenantMigrations } from "./utils/schema.manager.js";

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
import { initSocket, getIO } from "./config/socket.js";
import * as whatsappService from "./utils/whatsapp.service.js";
import { startWhatsAppCleanupScheduler } from "./utils/whatsapp-cleanup-scheduler.js";

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
import Customer from "./domains/customers/customer.model.js";
import User from "./domains/auth/user.model.js";
import Branch from "./domains/store/branch.model.js";
import Invoice from "./domains/sales/invoice.model.js";
import InvoiceItem from "./domains/sales/invoice-item.model.js";
import InvoicePayment from "./domains/sales/payment.model.js";
import Refund from "./domains/sales/refund.model.js";
import RefundItem from "./domains/sales/refund-item.model.js";
import RefundPayment from "./domains/sales/refund-payment.model.js";
import InventoryItem from "./domains/inventory/item.model.js";
import CustomInventoryOption from "./domains/inventory/custom-option.model.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = http.createServer(app);

app.set("trust proxy", 1);

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
  })
);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
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

User.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
Branch.hasMany(User, { foreignKey: "branch_id" });

Invoice.belongsTo(Customer, { foreignKey: "customer_id", as: "customer" });
Customer.hasMany(Invoice, { foreignKey: "customer_id" });

Invoice.belongsTo(User, { foreignKey: "created_by", as: "creator" });
User.hasMany(Invoice, { foreignKey: "created_by" });

Invoice.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
Branch.hasMany(Invoice, { foreignKey: "branch_id" });

Invoice.hasMany(InvoiceItem, { foreignKey: "invoice_id", as: "items" });
InvoiceItem.belongsTo(Invoice, { foreignKey: "invoice_id" });

Invoice.hasMany(InvoicePayment, { foreignKey: "invoice_id", as: "payments" });
InvoicePayment.belongsTo(Invoice, { foreignKey: "invoice_id" });

Invoice.hasMany(Refund, { foreignKey: "invoice_id", as: "refunds" });
Refund.belongsTo(Invoice, { foreignKey: "invoice_id", as: "invoice" });
Refund.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
Refund.belongsTo(User, { foreignKey: "created_by", as: "creator" });
Refund.hasMany(RefundItem, { foreignKey: "refund_id", as: "items" });
RefundItem.belongsTo(Refund, { foreignKey: "refund_id" });
RefundItem.belongsTo(InvoiceItem, {
  foreignKey: "invoice_item_id",
  as: "invoice_item",
});
RefundItem.belongsTo(InventoryItem, {
  foreignKey: "inventory_item_id",
  as: "inventory_item",
});
Refund.hasMany(RefundPayment, { foreignKey: "refund_id", as: "payments" });
RefundPayment.belongsTo(Refund, { foreignKey: "refund_id" });

InventoryItem.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
Branch.hasMany(InventoryItem, { foreignKey: "branch_id" });

InvoiceItem.belongsTo(InventoryItem, {
  foreignKey: "inventory_item_id",
  as: "inventory_item",
});
InventoryItem.hasMany(InvoiceItem, {
  foreignKey: "inventory_item_id",
  as: "InvoiceItems",
});

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
    logger.info("Platform tables synced (public schema)", {
      component: "startup",
    });

    const tenants = await Tenant.findAll();
    logger.info("Checking tenant schemas", {
      component: "startup",
      tenantCount: tenants.length,
    });

    const requiredTables = [
      "branches",
      "users",
      "customers",
      "inventory_items",
      "custom_inventory_options",
      "invoices",
      "invoice_items",
      "invoice_payments",
      "refunds",
      "refund_items",
      "refund_payments",
    ];

    for (const tenant of tenants) {
      const schema = tenant.db_schema;

      await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);

      try {

        const [tableCheck] = await sequelize.query(
          `SELECT COUNT(*)::int as table_count
           FROM information_schema.tables
           WHERE table_schema = $1
           AND table_name = ANY($2::text[])`,
          {
            bind: [schema, requiredTables],
            type: sequelize.QueryTypes.SELECT,
          }
        );

        const existingTableCount = tableCheck?.table_count || 0;

        if (existingTableCount === 0) {

          logger.info("New tenant detected, performing initial sync", {
            component: "startup",
            schema,
          });

          await sequelize.query(`SET search_path TO "${schema}", public`);

          await Branch.schema(schema).sync({ alter: false });
          await User.schema(schema).sync({ alter: false });
          await Customer.schema(schema).sync({ alter: false });
          await InventoryItem.schema(schema).sync({ alter: false });

          try {
            await sequelize.query(`SET search_path TO "${schema}", public`);
            await CustomInventoryOption.schema(schema).sync({ alter: false });
          } catch (customOptionError) {
            logger.warn("CustomInventoryOption sync failed (non-critical)", {
              component: "startup",
              schema,
              error: customOptionError.message,
            });
          }

          await sequelize.query(`SET search_path TO "${schema}", public`);
          await Invoice.schema(schema).sync({ alter: false });
          await InvoiceItem.schema(schema).sync({ alter: false });
          await InvoicePayment.schema(schema).sync({ alter: false });
          await Refund.schema(schema).sync({ alter: false });
          await RefundItem.schema(schema).sync({ alter: false });
          await RefundPayment.schema(schema).sync({ alter: false });

          await sequelize.query("SET search_path TO public");
        } else if (existingTableCount < requiredTables.length) {

          logger.info(
            "Partial tenant schema detected, syncing missing tables",
            {
              component: "startup",
              schema,
              existingTables: existingTableCount,
              requiredTables: requiredTables.length,
            }
          );

          await sequelize.query(`SET search_path TO "${schema}", public`);

          await Branch.schema(schema).sync({ alter: false });
          await User.schema(schema).sync({ alter: false });
          await Customer.schema(schema).sync({ alter: false });
          await InventoryItem.schema(schema).sync({ alter: false });

          try {
            await CustomInventoryOption.schema(schema).sync({ alter: false });
          } catch (customOptionError) {
            logger.warn("CustomInventoryOption sync failed (non-critical)", {
              component: "startup",
              schema,
              error: customOptionError.message,
            });
          }

          await Invoice.schema(schema).sync({ alter: false });
          await InvoiceItem.schema(schema).sync({ alter: false });
          await InvoicePayment.schema(schema).sync({ alter: false });
          await Refund.schema(schema).sync({ alter: false });
          await RefundItem.schema(schema).sync({ alter: false });
          await RefundPayment.schema(schema).sync({ alter: false });

          await sequelize.query("SET search_path TO public");
        } else { void 0; }

        await ensureTenantMigrations(schema);
      } catch (checkError) {
        logger.warn("Tenant schema check failed, will sync on first use", {
          component: "startup",
          schema,
          error: checkError.message,
        });

      }
    }

    logger.info("Tenant schema check completed", {
      component: "startup",
      note: "Full sync will happen lazily when tenants are first used",
    });

    startWhatsAppCleanupScheduler();
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

      (async () => {
        try {
          const tenants = await Tenant.findAll();

          for (const t of tenants) {
            const slug = t.slug || t.db_schema;
            const schema = t.db_schema;

            try {

              await sequelize.query(`SET search_path TO "${schema}", public`);

              const tenantConfig = await WhatsappConfig.findOne({
                where: {
                  tenant_slug: slug,
                  branch_id: { [sequelize.Sequelize.Op.is]: null },
                },
              });

              if (tenantConfig && tenantConfig.session_status === "CONNECTED") {
                const timeoutPromise = new Promise((_, reject) =>
                  setTimeout(() => reject(new Error("Connection timeout")), 30000)
                );
                Promise.race([
                  whatsappService.connectToWhatsApp(slug),
                  timeoutPromise,
                ]).catch((err) => {
                  logger.warn("WhatsApp startup reconnect failed", {
                    component: "startup",
                    tenant: slug,
                    error: err?.message,
                  });
                });
              }

              const branches = await Branch.schema(schema).findAll({
                attributes: ["id"],
              });

              for (const branch of branches) {
                const branchConfig = await WhatsappConfig.findOne({
                  where: {
                    tenant_slug: slug,
                    branch_id: branch.id,
                  },
                });

                if (branchConfig && branchConfig.session_status === "CONNECTED") {
                  const timeoutPromise = new Promise((_, reject) =>
                    setTimeout(
                      () => reject(new Error("Connection timeout")),
                      30000
                    )
                  );
                  Promise.race([
                    whatsappService.connectToWhatsApp(slug, null, {
                      branchId: branch.id,
                    }),
                    timeoutPromise,
                  ]).catch((err) => {
                    logger.warn("WhatsApp branch startup reconnect failed", {
                      component: "startup",
                      tenant: slug,
                      branchId: branch.id,
                      error: err?.message,
                    });
                  });
                }
              }
            } catch (tenantErr) {
              logger.warn("WhatsApp tenant reconnect error", {
                component: "startup",
                tenant: slug,
                error: tenantErr?.message,
              });
            }
          }
        } catch (e) {
          logger.warn("WhatsApp startup reconnect error", {
            component: "startup",
            error: e?.message,
          });
        }
      })();
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
