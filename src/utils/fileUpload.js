import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import sharp from "sharp";
import logger from "./logger.js";

const sanitizeSegment = (value) =>
  String(value || "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");

export const getR2Config = () => {
  const accountId = (process.env.R2_ACCOUNT_ID || "").trim();
  const endpoint = (
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "")
  )
    .trim()
    .replace(/\/+$/, "");
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (process.env.R2_BUCKET_NAME || "").trim();
  const publicUrl = (process.env.R2_PUBLIC_URL || "").trim().replace(/\/+$/, "");
  const prefix = sanitizeSegment(process.env.R2_FOLDER || "kuwaitqumash") || "kuwaitqumash";

  const configured = Boolean(endpoint && accessKeyId && secretAccessKey && bucket && publicUrl);
  return { endpoint, accessKeyId, secretAccessKey, bucket, publicUrl, prefix, configured };
};

let cachedClientKey = "";
let cachedClient = null;
let warnedUnconfigured = false;

const getS3Client = (cfg) => {
  if (!cfg.configured) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.warn("Cloudflare R2 is not configured, image uploads are skipped.", {
        component: "fileUpload",
      });
    }
    return null;
  }

  const key = `${cfg.endpoint}|${cfg.accessKeyId}|${cfg.bucket}`;
  if (cachedClient && cachedClientKey === key) {
    return cachedClient;
  }

  cachedClient = new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });
  cachedClientKey = key;
  return cachedClient;
};

const readUploadedBuffer = async (file) => {
  if (Buffer.isBuffer(file?.buffer) && file.buffer.length > 0) {
    return file.buffer;
  }
  if (file?.path) {
    return fs.promises.readFile(file.path);
  }
  throw new Error("Uploaded file has neither buffer nor path.");
};

const removeTempFile = async (file) => {
  if (!file?.path) return;
  try {
    await fs.promises.unlink(file.path);
  } catch (err) {
    if (err?.code !== "ENOENT") {
      logger.debug("Temp file cleanup failed", {
        component: "fileUpload",
        path: file.path,
        error: err?.message,
      });
    }
  }
};

export const buildObjectKey = (segments) =>
  segments
    .map((segment) => sanitizeSegment(segment))
    .filter(Boolean)
    .join("/");

export const extractObjectKeyFromUrl = (imageUrl) => {
  if (!imageUrl || typeof imageUrl !== "string") return null;

  const { publicUrl, bucket } = getR2Config();
  const trimmed = imageUrl.trim();

  if (publicUrl && trimmed.startsWith(`${publicUrl}/`)) {
    return trimmed.slice(publicUrl.length + 1);
  }

  try {
    const parsed = new URL(trimmed);
    const pathname = parsed.pathname.replace(/^\/+/, "");
    if (!pathname) return null;
    if (bucket && pathname.startsWith(`${bucket}/`)) {
      return pathname.slice(bucket.length + 1);
    }
    return pathname;
  } catch {
    return null;
  }
};

const uploadBufferToR2 = async ({ buffer, key, contentType }) => {
  const cfg = getR2Config();
  const client = getS3Client(cfg);
  if (!client) return null;

  await client.send(
    new PutObjectCommand({
      Bucket: cfg.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
      CacheControl: "public, max-age=31536000, immutable",
    }),
  );

  return `${cfg.publicUrl}/${key}`;
};

export const saveImage = async (
  file,
  folderType = "general",
  subFolder = "",
  store = null,
) => {
  if (!file) return null;

  const cfg = getR2Config();
  if (!getS3Client(cfg)) {
    await removeTempFile(file);
    return null;
  }

  try {
    const rawBuffer = await readUploadedBuffer(file);
    const compressedBuffer = await sharp(rawBuffer)
      .resize(600, 600, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80 })
      .toBuffer();

    const fileId = crypto.randomUUID();
    const dirKey = buildObjectKey([
      cfg.prefix,
      store,
      folderType,
      subFolder,
    ]);
    const key = path.posix.join(dirKey, `${fileId}.webp`);

    return await uploadBufferToR2({
      buffer: compressedBuffer,
      key,
      contentType: "image/webp",
    });
  } catch (error) {
    logger.error("Failed to process/upload image to R2", {
      component: "fileUpload",
      error: error?.message,
    });
    throw new Error("Image upload failed");
  } finally {
    await removeTempFile(file);
  }
};

export const saveBranchLogo = async (file, store, branchId) => {
  if (!file) return null;

  const cfg = getR2Config();
  if (!getS3Client(cfg)) {
    await removeTempFile(file);
    return null;
  }

  try {
    const rawBuffer = await readUploadedBuffer(file);
    const pngBuffer = await sharp(rawBuffer)
      .resize(1000, 1000, { fit: "inside", withoutEnlargement: true })
      .png({ quality: 95, compressionLevel: 6 })
      .toBuffer();

    const dirKey = buildObjectKey([
      cfg.prefix,
      store,
      "branches",
      `branch_${branchId}`,
    ]);
    const key = path.posix.join(dirKey, `logo_${Date.now()}.png`);

    return await uploadBufferToR2({
      buffer: pngBuffer,
      key,
      contentType: "image/png",
    });
  } catch (error) {
    logger.error("Failed to process/upload branch logo to R2", {
      component: "fileUpload",
      error: error?.message,
    });
    throw new Error("Logo upload failed");
  } finally {
    await removeTempFile(file);
  }
};

export const deleteImage = async (imageUrl) => {
  if (!imageUrl) return;

  const cfg = getR2Config();
  const client = getS3Client(cfg);
  if (!client) return;

  // Gracefully ignore non-R2 legacy URLs during Cloudinary -> R2 transition.
  if (imageUrl.includes("res.cloudinary.com")) {
    logger.debug("Skipping legacy Cloudinary delete after R2 migration", {
      component: "fileUpload",
    });
    return;
  }

  const key = extractObjectKeyFromUrl(imageUrl);
  if (!key) return;

  try {
    await client.send(
      new DeleteObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
      }),
    );
  } catch (error) {
    logger.error("Failed to delete image from R2", {
      component: "fileUpload",
      key,
      error: error?.message,
    });
  }
};

export const deleteStoreFolder = async (store) => {
  if (!store) return;

  const cfg = getR2Config();
  const client = getS3Client(cfg);
  if (!client) return;

  const prefix = buildObjectKey([cfg.prefix, store]);
  if (!prefix) return;

  try {
    let continuationToken;
    do {
      const listRes = await client.send(
        new ListObjectsV2Command({
          Bucket: cfg.bucket,
          Prefix: `${prefix}/`,
          ContinuationToken: continuationToken,
        }),
      );

      if (listRes.Contents && listRes.Contents.length > 0) {
        const objects = listRes.Contents.map((item) => ({ Key: item.Key }));
        await client.send(
          new DeleteObjectsCommand({
            Bucket: cfg.bucket,
            Delete: { Objects: objects },
          }),
        );
      }
      continuationToken = listRes.NextContinuationToken;
    } while (continuationToken);

    logger.info("Purged store objects from R2", {
      component: "fileUpload",
      store,
      prefix,
    });
  } catch (error) {
    logger.warn("Failed to delete store folder from R2", {
      component: "fileUpload",
      store,
      error: error?.message,
    });
  }
};

