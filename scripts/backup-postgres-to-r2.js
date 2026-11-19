import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import "../src/config/env.js";
import logger from "../src/utils/logger.js";

const buildBackupR2Config = () => {
  const accountId = (process.env.R2_ACCOUNT_ID || "").trim();
  const endpoint = (
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "")
  )
    .trim()
    .replace(/\/+$/, "");
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (
    process.env.R2_BACKUP_BUCKET_NAME ||
    process.env.R2_BUCKET_NAME ||
    ""
  ).trim();
  const prefix = (process.env.R2_BACKUP_PREFIX || "backups/postgres")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  const retentionDays = Math.max(
    1,
    Number.parseInt(process.env.BACKUP_RETENTION_DAYS || "30", 10) || 30,
  );

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error(
      "Missing Cloudflare R2 backup credentials (R2_ACCOUNT_ID/R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME).",
    );
  }

  return { endpoint, accessKeyId, secretAccessKey, bucket, prefix, retentionDays };
};

const runPgDumpToGzipFile = async (outputGzPath) => {
  const args = ["--format=plain", "--no-owner", "--no-acl"];
  const env = { ...process.env };

  if (process.env.DATABASE_URL) {
    args.push(process.env.DATABASE_URL);
  } else {
    args.push(
      "-h",
      process.env.DB_HOST || "127.0.0.1",
      "-p",
      String(process.env.DB_PORT || "5432"),
      "-U",
      process.env.DB_USER,
      "-d",
      process.env.DB_NAME,
    );
    if (process.env.DB_PASS) {
      env.PGPASSWORD = process.env.DB_PASS;
    }
  }

  const child = spawn("pg_dump", args, {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const gzip = zlib.createGzip({ level: 6 });
  const writeStream = fs.createWriteStream(outputGzPath);

  const exitPromise = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`pg_dump exited with code ${code}: ${stderr.trim()}`));
    });
  });

  await Promise.all([pipeline(child.stdout, gzip, writeStream), exitPromise]);
};

const pruneOldBackups = async (s3, bucket, prefix, retentionDays) => {
  const cutoffMs = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let continuationToken;
  const expiredKeys = [];

  do {
    const res = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: `${prefix}/`,
        ContinuationToken: continuationToken,
      }),
    );

    for (const item of res.Contents || []) {
      if (item.LastModified && item.LastModified.getTime() < cutoffMs) {
        expiredKeys.push({ Key: item.Key });
      }
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);

  if (expiredKeys.length === 0) return 0;

  for (let i = 0; i < expiredKeys.length; i += 1000) {
    await s3.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: { Objects: expiredKeys.slice(i, i + 1000) },
      }),
    );
  }

  return expiredKeys.length;
};

const runBackup = async () => {
  const cfg = buildBackupR2Config();
  const s3 = new S3Client({
    region: "auto",
    endpoint: cfg.endpoint,
    credentials: {
      accessKeyId: cfg.accessKeyId,
      secretAccessKey: cfg.secretAccessKey,
    },
  });

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `kuwaitqumash-pg-${timestamp}.sql.gz`;
  const tempPath = path.join(os.tmpdir(), fileName);
  const key = `${cfg.prefix}/${fileName}`;

  try {
    logger.info("Starting PostgreSQL pg_dump backup", {
      component: "backup",
      key,
    });

    await runPgDumpToGzipFile(tempPath);
    const stats = await fs.promises.stat(tempPath);

    await s3.send(
      new PutObjectCommand({
        Bucket: cfg.bucket,
        Key: key,
        Body: fs.createReadStream(tempPath),
        ContentLength: stats.size,
        ContentType: "application/gzip",
      }),
    );

    const prunedCount = await pruneOldBackups(
      s3,
      cfg.bucket,
      cfg.prefix,
      cfg.retentionDays,
    );

    logger.info("PostgreSQL backup uploaded to Cloudflare R2", {
      component: "backup",
      key,
      bytes: stats.size,
      prunedOldBackups: prunedCount,
    });
  } finally {
    await fs.promises.unlink(tempPath).catch(() => {});
  }
};

runBackup().catch((error) => {
  logger.error("PostgreSQL backup to R2 failed", {
    component: "backup",
    error: error?.message,
    stack: error?.stack,
  });
  process.exit(1);
});

