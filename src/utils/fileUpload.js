import sharp from "sharp";
import fs from "fs";
import { v2 as cloudinary } from "cloudinary";
import logger from "./logger.js";

sharp.cache(false);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const ROOT = process.env.CLOUDINARY_FOLDER || "gold_app";

const sanitizeSegment = (s) =>
  (s || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "general";

/** Build store-scoped path: {store}/customers|inventory/{subPath}. subPath may contain / e.g. "Ring/BRC123". */
const buildPath = (store, folderType, subPath) => {
  const safeStore = sanitizeSegment(String(store));
  const parts = (subPath || "general")
    .split("/")
    .map(sanitizeSegment)
    .filter(Boolean);
  const subFolder = parts.length ? parts.join("/") : "general";
  return {
    safeStore,
    subFolder,
    full: `${safeStore}/${folderType}/${subFolder}`,
  };
};

/**
 * Save image. Store-scoped: gold_app/{store}/customers|inventory/{subPath}.
 * Images are processed and uploaded directly to Cloudinary (no local storage).
 * @param {object} file - Multer file
 * @param {'customers'|'inventory'} folderType
 * @param {string} subFolder - e.g. civil_id, or "category/barcode" for inventory
 * @param {string} store - tenant slug (required for isolation)
 */
export const saveImage = async (file, folderType, subFolder, store) => {
  if (!file) return null;

  const storeVal = store || "default";
  const {
    full,
  } = buildPath(storeVal, folderType, subFolder);

  const filename = `${folderType}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

  // Process image in memory (resize and convert to webp)
  const processedBuffer = await sharp(file.path)
    .resize(600, 600, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();

  // Clean up temp file
  setTimeout(() => {
    try {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (e) {
      logger.warn("Temp file cleanup failed", {
        component: "fileUpload",
        error: e?.message,
      });
    }
  }, 1000);

  // Upload directly to Cloudinary
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder: `${ROOT}/${full}`,
          public_id: filename,
          resource_type: "image",
          format: "webp",
        },
        (error, result) => {
          if (error) {
            logger.error("Cloudinary upload failed", {
              component: "fileUpload",
              error: error?.message,
            });
            reject(
              new Error(
                `Failed to upload image to Cloudinary: ${error?.message}`,
              ),
            );
          } else {
            resolve(result.secure_url);
          }
        },
      )
      .end(processedBuffer);
  });
};

export const saveBranchLogo = async (file, store, branchId) => {
  if (!file) return null;

  const storeVal = store || "default";
  const safeStore = sanitizeSegment(String(storeVal));
  const filename = `branch-logo-${branchId}-${Date.now()}`;

  // Process image in memory (resize to max 1000x1000, maintain aspect ratio)
  // Use PNG format to preserve transparency for logos (better for PDF generation)
  const processedBuffer = await sharp(file.path)
    .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
    .png({ quality: 100, compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();

  // Clean up temp file
  setTimeout(() => {
    try {
      if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
    } catch (e) {
      logger.warn("Temp file cleanup failed", {
        component: "fileUpload",
        error: e?.message,
      });
    }
  }, 1000);

  // Upload directly to Cloudinary
  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder: `${ROOT}/${safeStore}/branches`,
          public_id: filename,
          resource_type: "image",
          format: "png", // Use PNG to preserve transparency
        },
        (error, result) => {
          if (error) {
            logger.error("Cloudinary upload failed for branch logo", {
              component: "fileUpload",
              error: error?.message,
            });
            reject(
              new Error(
                `Failed to upload branch logo to Cloudinary: ${error?.message}`,
              ),
            );
          } else {
            resolve(result.secure_url);
          }
        },
      )
      .end(processedBuffer);
  });
};

export const deleteImage = async (imageUrl) => {
  if (!imageUrl) return;

  // Only delete from Cloudinary (no local storage)
  if (imageUrl.includes("cloudinary.com")) {
    try {
      const splitUrl = imageUrl.split("/");
      const folderStartIndex = splitUrl.findIndex((part) => part === ROOT);

      if (folderStartIndex !== -1) {
        const pathParts = splitUrl.slice(folderStartIndex);
        const publicIdWithExt = pathParts.join("/");
        const publicId = publicIdWithExt.replace(/\.[^/.]+$/, "");
        await cloudinary.uploader.destroy(publicId);
        logger.info("Image deleted from Cloudinary", {
          component: "fileUpload",
          publicId,
        });
      }
    } catch (error) {
      logger.warn("Cloudinary destroy failed", {
        component: "fileUpload",
        error: error?.message,
      });
    }
  } else {
    logger.warn("Image URL is not a Cloudinary URL, skipping delete", {
      component: "fileUpload",
      imageUrl,
    });
  }
};
