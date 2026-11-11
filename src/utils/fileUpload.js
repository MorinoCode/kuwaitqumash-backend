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

const ROOT = process.env.CLOUDINARY_FOLDER || "kuwaitqumash";

const sanitizeSegment = (s) =>
  (s || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "") || "general";

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

export const saveImage = async (file, folderType, subFolder, store) => {
  if (!file) return null;

  const storeVal = store || "default";
  const {
    full,
  } = buildPath(storeVal, folderType, subFolder);

  const filename = `${folderType}-${Date.now()}-${Math.round(Math.random() * 1e9)}`;

  const processedBuffer = await sharp(file.path)
    .resize(600, 600, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 75 })
    .toBuffer();

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

  const processedBuffer = await sharp(file.path)
    .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
    .png({ quality: 100, compressionLevel: 6, adaptiveFiltering: true })
    .toBuffer();

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

  return new Promise((resolve, reject) => {
    cloudinary.uploader
      .upload_stream(
        {
          folder: `${ROOT}/${safeStore}/branches`,
          public_id: filename,
          resource_type: "image",
          format: "png",
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
