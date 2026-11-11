import { Storage } from "@google-cloud/storage";
import fs from "fs";
import path from "path";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";
import logger from "./logger.js";

let storage = null;
let bucket = null;
const BUCKET_NAME =
  process.env.WHATSAPP_SESSIONS_BUCKET || "kuwiatgoldpro-whatsapp-sessions";

const initStorage = () => {
  if (storage) return;

  try {
    storage = new Storage({
      projectId: process.env.GCP_PROJECT_ID || "kuwiatgoldpro",
    });
    bucket = storage.bucket(BUCKET_NAME);
    logger.info("GCS Storage initialized for WhatsApp sessions", {
      component: "whatsapp-gcs",
      bucket: BUCKET_NAME,
    });
  } catch (error) {
    logger.error("Failed to initialize GCS Storage", {
      component: "whatsapp-gcs",
      error: error?.message,
    });
    throw error;
  }
};

/**
 * Check if we should use GCS (production) or local filesystem (local dev)
 */
const shouldUseGCS = () => {
  return (
    process.env.USE_GCS_FOR_WHATSAPP === "true" ||
    process.env.NODE_ENV === "production"
  );
};

/**
 * Get file path in GCS bucket
 * Format: whatsapp_sessions/{sessionKey}/{filename}
 */
const getGCSFilePath = (sessionKey, filename) => {
  return `whatsapp_sessions/${sessionKey}/${filename}`;
};

/**
 * Read file from GCS or local filesystem
 */
export const readFile = async (sessionKey, filename) => {
  if (!shouldUseGCS()) {
    // Local development: use filesystem
    const localPath = path.join(
      process.cwd(),
      "whatsapp_sessions",
      sessionKey,
      filename
    );
    if (!fs.existsSync(localPath)) return null;
    return fs.readFileSync(localPath, "utf-8");
  }

  // Production: use GCS
  try {
    initStorage();
    const filePath = getGCSFilePath(sessionKey, filename);
    const file = bucket.file(filePath);

    const [exists] = await file.exists();
    if (!exists) return null;

    const [contents] = await file.download();
    return contents.toString("utf-8");
  } catch (error) {
    logger.error("Failed to read file from GCS", {
      component: "whatsapp-gcs",
      sessionKey,
      filename,
      error: error?.message,
    });
    return null;
  }
};

/**
 * Write file to GCS or local filesystem
 */
export const writeFile = async (sessionKey, filename, data) => {
  if (!shouldUseGCS()) {
    // Local development: use filesystem
    const localDir = path.join(process.cwd(), "whatsapp_sessions", sessionKey);
    if (!fs.existsSync(localDir)) {
      fs.mkdirSync(localDir, { recursive: true });
    }
    const localPath = path.join(localDir, filename);
    fs.writeFileSync(localPath, data, "utf-8");
    return;
  }

  // Production: use GCS
  try {
    initStorage();
    const filePath = getGCSFilePath(sessionKey, filename);
    const file = bucket.file(filePath);

    await file.save(data, {
      contentType: "application/json",
      metadata: {
        cacheControl: "no-cache",
      },
    });

    logger.debug("File written to GCS", {
      component: "whatsapp-gcs",
      sessionKey,
      filename,
    });
  } catch (error) {
    logger.error("Failed to write file to GCS", {
      component: "whatsapp-gcs",
      sessionKey,
      filename,
      error: error?.message,
    });
    throw error;
  }
};

/**
 * Delete file from GCS or local filesystem
 */
export const deleteFile = async (sessionKey, filename) => {
  if (!shouldUseGCS()) {
    // Local development: use filesystem
    const localPath = path.join(
      process.cwd(),
      "whatsapp_sessions",
      sessionKey,
      filename
    );
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
    return;
  }

  // Production: use GCS
  try {
    initStorage();
    const filePath = getGCSFilePath(sessionKey, filename);
    const file = bucket.file(filePath);

    const [exists] = await file.exists();
    if (exists) {
      await file.delete();
      logger.debug("File deleted from GCS", {
        component: "whatsapp-gcs",
        sessionKey,
        filename,
      });
    }
  } catch (error) {
    logger.error("Failed to delete file from GCS", {
      component: "whatsapp-gcs",
      sessionKey,
      filename,
      error: error?.message,
    });
  }
};

/**
 * List all files in a session directory
 */
export const listFiles = async (sessionKey) => {
  if (!shouldUseGCS()) {
    // Local development: use filesystem
    const localDir = path.join(process.cwd(), "whatsapp_sessions", sessionKey);
    if (!fs.existsSync(localDir)) return [];
    return fs.readdirSync(localDir);
  }

  // Production: use GCS
  try {
    initStorage();
    const prefix = `whatsapp_sessions/${sessionKey}/`;
    const [files] = await bucket.getFiles({ prefix });

    return files
      .map((file) => {
        // Extract filename from full path
        const fullPath = file.name;
        return fullPath.replace(prefix, "");
      })
      .filter(Boolean);
  } catch (error) {
    logger.error("Failed to list files from GCS", {
      component: "whatsapp-gcs",
      sessionKey,
      error: error?.message,
    });
    return [];
  }
};

/**
 * Delete entire session directory
 */
export const deleteSessionDir = async (sessionKey) => {
  if (!shouldUseGCS()) {
    // Local development: use filesystem
    const localDir = path.join(process.cwd(), "whatsapp_sessions", sessionKey);
    if (fs.existsSync(localDir)) {
      fs.rmSync(localDir, { recursive: true, force: true });
    }
    return;
  }

  // Production: use GCS
  try {
    initStorage();
    const prefix = `whatsapp_sessions/${sessionKey}/`;
    const [files] = await bucket.getFiles({ prefix });

    // Delete all files in this session
    await Promise.all(files.map((file) => file.delete()));

    logger.info("Session directory deleted from GCS", {
      component: "whatsapp-gcs",
      sessionKey,
    });
  } catch (error) {
    logger.error("Failed to delete session directory from GCS", {
      component: "whatsapp-gcs",
      sessionKey,
      error: error?.message,
    });
  }
};

/**
 * Custom auth state adapter for Baileys
 * این تابع یک adapter می‌سازد که با useMultiFileAuthState سازگار است
 *
 * Baileys از یک folder path استفاده می‌کند و خودش فایل‌ها را می‌خواند/می‌نویسد.
 * ما یک temporary local folder می‌سازیم، فایل‌ها را از GCS sync می‌کنیم،
 * و بعد از تغییرات دوباره به GCS sync می‌کنیم.
 */
export const createGCSAuthState = async (sessionKey) => {
  const tempDir = path.join(process.cwd(), "whatsapp_sessions", sessionKey);

  // Ensure temp directory exists
  if (!fs.existsSync(tempDir)) {
    fs.mkdirSync(tempDir, { recursive: true });
  }

  const fileStatsCache = new Map();

  // Sync from GCS to local temp directory
  try {
    const files = await listFiles(sessionKey);
    const BATCH_SIZE = 20;
    for (let i = 0; i < files.length; i += BATCH_SIZE) {
      const batch = files.slice(i, i + BATCH_SIZE);
      await Promise.all(
        batch.map(async (file) => {
          const data = await readFile(sessionKey, file);
          if (data !== null) {
            const localPath = path.join(tempDir, file);
            fs.writeFileSync(localPath, data, "utf-8");
            const stat = fs.statSync(localPath);
            fileStatsCache.set(file, stat.mtimeMs);
          }
        })
      );
    }
    
    logger.debug("Synced files from GCS to local", {
      component: "whatsapp-gcs",
      sessionKey,
      fileCount: files.length,
    });
  } catch (error) {
    logger.warn("Failed to sync from GCS, using empty state", {
      component: "whatsapp-gcs",
      sessionKey,
      error: error?.message,
    });
  }

  const { state, saveCreds: originalSaveCreds } = await useMultiFileAuthState(
    tempDir
  );

  const saveCreds = async () => {
    await originalSaveCreds();

    try {
      const currentFileList = fs.readdirSync(tempDir);
      const currentFiles = new Set(currentFileList);
      const uploadPromises = [];
      const deletePromises = [];
      
      for (const file of currentFileList) {
        const localPath = path.join(tempDir, file);
        const stat = fs.statSync(localPath);
        
        if (stat.isFile()) {
          const lastMtime = fileStatsCache.get(file);
          if (lastMtime !== stat.mtimeMs) {
            const data = fs.readFileSync(localPath, "utf-8");
            const uploadPromise = writeFile(sessionKey, file, data)
              .then(() => {
                fileStatsCache.set(file, stat.mtimeMs);
              })
              .catch((err) => {
                logger.error("Failed to sync specific file to GCS", {
                  component: "whatsapp-gcs",
                  sessionKey,
                  file,
                  error: err?.message,
                });
              });
            uploadPromises.push(uploadPromise);
          }
        }
      }

      for (const [cachedFile] of fileStatsCache.entries()) {
        if (!currentFiles.has(cachedFile)) {
          const deletePromise = deleteFile(sessionKey, cachedFile)
            .then(() => {
              fileStatsCache.delete(cachedFile);
            })
            .catch((err) => {
              logger.error("Failed to delete removed file from GCS", {
                component: "whatsapp-gcs",
                sessionKey,
                file: cachedFile,
                error: err?.message,
              });
            });
          deletePromises.push(deletePromise);
        }
      }

      if (uploadPromises.length > 0) {
        await Promise.all(uploadPromises);
        logger.debug("Synced modified files from local to GCS", {
          component: "whatsapp-gcs",
          sessionKey,
          modifiedCount: uploadPromises.length,
        });
      }

      if (deletePromises.length > 0) {
        await Promise.all(deletePromises);
        logger.debug("Synced deleted files from local to GCS", {
          component: "whatsapp-gcs",
          sessionKey,
          deletedCount: deletePromises.length,
        });
      }
    } catch (error) {
      logger.error("Failed to sync to GCS after saveCreds", {
        component: "whatsapp-gcs",
        sessionKey,
        error: error?.message,
      });
    }
  };

  return { state, saveCreds };
};
