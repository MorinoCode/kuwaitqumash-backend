import cron from "node-cron";
import logger from "./logger.js";
import { Storage } from "@google-cloud/storage";

const BUCKET_NAME =
  process.env.WHATSAPP_SESSIONS_BUCKET || "kuwaitqumash-whatsapp-sessions";
const DAYS_OLD = 2;

const ESSENTIAL_FILES = [
  "creds.json",
  "app-state-sync-key-",
];

const TEMP_FILE_PATTERNS = [
  "pre-key-",
  "app-state-sync-version-",
  "sender-key-",
  "session-",
];

function isEssentialFile(filename) {
  return ESSENTIAL_FILES.some((pattern) => {
    if (pattern.endsWith("-")) {
      return filename.startsWith(pattern);
    }
    return filename === pattern;
  });
}

function isTempFile(filename) {
  if (isEssentialFile(filename)) {
    return false;
  }
  return TEMP_FILE_PATTERNS.some((pattern) => filename.startsWith(pattern));
}

async function cleanupSession(storage, sessionKey) {
  const prefix = `whatsapp_sessions/${sessionKey}/`;
  const [files] = await storage.bucket(BUCKET_NAME).getFiles({ prefix });

  let deleted = 0;
  let freed = 0;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - DAYS_OLD);

  for (const file of files) {
    const filename = file.name.replace(prefix, "");

    if (isEssentialFile(filename)) {
      continue;
    }

    if (!isTempFile(filename)) {
      continue;
    }

    try {
      const [metadata] = await file.getMetadata();
      const updated = new Date(metadata.updated || metadata.timeCreated);

      if (updated < cutoffDate) {
        await file.delete();
        deleted++;
        freed += parseInt(metadata.size || 0);
      }
    } catch (error) {
      logger.warn("Failed to delete file during cleanup", {
        component: "whatsapp-cleanup",
        sessionKey,
        filename,
        error: error?.message,
      });
    }
  }

  return { deleted, freed };
}

async function runCleanup() {

  if (
    process.env.NODE_ENV !== "production" ||
    process.env.USE_GCS_FOR_WHATSAPP !== "true"
  ) {
    return;
  }

  try {
    logger.info("Starting WhatsApp sessions cleanup", {
      component: "whatsapp-cleanup",
    });

    const storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID || "kuwaitqumash",
    });

    const bucket = storage.bucket(BUCKET_NAME);

    const [exists] = await bucket.exists();
    if (!exists) {
      logger.warn("WhatsApp sessions bucket does not exist", {
        component: "whatsapp-cleanup",
        bucket: BUCKET_NAME,
      });
      return;
    }

    const [allFiles] = await bucket.getFiles({ prefix: "whatsapp_sessions/" });

    const sessionKeys = new Set();
    for (const file of allFiles) {
      const pathParts = file.name.split("/");
      if (pathParts.length >= 2 && pathParts[0] === "whatsapp_sessions") {
        sessionKeys.add(pathParts[1]);
      }
    }

    if (sessionKeys.size === 0) {
      logger.info("No WhatsApp sessions found to cleanup", {
        component: "whatsapp-cleanup",
      });
      return;
    }

    let totalDeleted = 0;
    let totalFreed = 0;

    for (const sessionKey of sessionKeys) {
      const { deleted, freed } = await cleanupSession(storage, sessionKey);
      totalDeleted += deleted;
      totalFreed += freed;
    }

    logger.info("WhatsApp sessions cleanup completed", {
      component: "whatsapp-cleanup",
      sessionsProcessed: sessionKeys.size,
      filesDeleted: totalDeleted,
      spaceFreedBytes: totalFreed,
    });
  } catch (error) {
    logger.error("WhatsApp sessions cleanup failed", {
      component: "whatsapp-cleanup",
      error: error?.message,
      stack: error?.stack,
    });
  }
}

export const startWhatsAppCleanupScheduler = () => {

  if (
    process.env.NODE_ENV !== "production" ||
    process.env.USE_GCS_FOR_WHATSAPP !== "true"
  ) {
    logger.info(
      "WhatsApp cleanup scheduler disabled (not in production or GCS not enabled)",
      {
        component: "whatsapp-cleanup",
      }
    );
    return;
  }

  cron.schedule("0 2 * * 0", () => {
    runCleanup().catch((error) => {
      logger.error("Scheduled WhatsApp cleanup failed", {
        component: "whatsapp-cleanup",
        error: error?.message,
      });
    });
  });

  logger.info("WhatsApp cleanup scheduler started (weekly: Sunday 2 AM UTC)", {
    component: "whatsapp-cleanup",
    bucket: BUCKET_NAME,
    daysOld: DAYS_OLD,
  });

  setTimeout(() => {
    runCleanup().catch((error) => {
      logger.warn("Initial WhatsApp cleanup failed", {
        component: "whatsapp-cleanup",
        error: error?.message,
      });
    });
  }, 5 * 60 * 1000);
};
