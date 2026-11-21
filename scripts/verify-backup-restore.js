import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";
import "../src/config/env.js";

const parseArgs = (argv) => {
  const opts = { file: null, restoreDb: null, localDump: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--file" && argv[i + 1]) opts.file = argv[++i];
    else if (argv[i] === "--restore-db" && argv[i + 1]) opts.restoreDb = argv[++i];
    else if (argv[i] === "--local-dump") opts.localDump = true;
  }
  return opts;
};

const runCmd = (bin, args, { env = process.stdin ? { ...process.env } : {}, inputStream = null } = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(bin, args, {
      env,
      stdio: [inputStream ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    if (inputStream) {
      inputStream.pipe(child.stdin);
    }
  });

const verifyGzipSqlArchive = async (gzPath) => {
  const gunzip = zlib.createGunzip();
  const stream = fs.createReadStream(gzPath).pipe(gunzip);
  let totalBytes = 0;
  let hasCreateTable = false;
  let hasPgDumpHeader = false;
  let sample = "";

  for await (const chunk of stream) {
    totalBytes += chunk.length;
    const text = chunk.toString("utf8");
    if (sample.length < 4096) sample += text;
    if (!hasPgDumpHeader && text.includes("PostgreSQL database dump")) hasPgDumpHeader = true;
    if (!hasCreateTable && /CREATE\s+TABLE/i.test(text)) hasCreateTable = true;
  }

  if (totalBytes === 0) {
    throw new Error("Backup archive decompressed to 0 bytes.");
  }
  if (!hasCreateTable) {
    throw new Error("Backup SQL archive does not contain any CREATE TABLE statements.");
  }

  return { totalBytes, hasPgDumpHeader, hasCreateTable };
};

const downloadLatestFromR2 = async (targetPath) => {
  const accountId = (process.env.R2_ACCOUNT_ID || "").trim();
  const endpoint = (
    process.env.R2_ENDPOINT ||
    (accountId ? `https://${accountId}.r2.cloudflarestorage.com` : "")
  ).trim().replace(/\/+$/, "");
  const accessKeyId = (process.env.R2_ACCESS_KEY_ID || "").trim();
  const secretAccessKey = (process.env.R2_SECRET_ACCESS_KEY || "").trim();
  const bucket = (process.env.R2_BACKUP_BUCKET_NAME || process.env.R2_BUCKET_NAME || "").trim();
  const prefix = (process.env.R2_BACKUP_PREFIX || "backups/postgres").trim().replace(/^\/+|\/+$/g, "");

  if (!endpoint || !accessKeyId || !secretAccessKey || !bucket) {
    throw new Error("R2 credentials not configured. Pass --file <backup.sql.gz> or --local-dump.");
  }

  const s3 = new S3Client({
    region: "auto",
    endpoint,
    credentials: { accessKeyId, secretAccessKey },
    forcePathStyle: true,
  });

  const list = await s3.send(
    new ListObjectsV2Command({ Bucket: bucket, Prefix: `${prefix}/` }),
  );
  const items = (list.Contents || [])
    .filter((o) => o.Key?.endsWith(".sql.gz"))
    .sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));

  if (items.length === 0) {
    throw new Error(`No .sql.gz backup archives found in s3://${bucket}/${prefix}/`);
  }

  const latest = items[0];
  const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: latest.Key }));
  await pipeline(obj.Body, fs.createWriteStream(targetPath));
  return { key: latest.Key, lastModified: latest.LastModified, size: latest.Size };
};

const createLocalDump = async (targetPath) => {
  const env = { ...process.env };
  if (process.env.DB_PASS) env.PGPASSWORD = process.env.DB_PASS;
  const args = [
    "--format=plain",
    "--no-owner",
    "--no-acl",
    "-h", process.env.DB_HOST || "127.0.0.1",
    "-p", String(process.env.DB_PORT || "5432"),
    "-U", process.env.DB_USER,
    "-d", process.env.DB_NAME,
  ];
  const child = spawn("pg_dump", args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const exitP = new Promise((res, rej) => {
    child.on("error", rej);
    child.on("close", (code) => (code === 0 ? res() : rej(new Error(`pg_dump failed (${code}): ${stderr}`))));
  });
  await Promise.all([
    pipeline(child.stdout, zlib.createGzip({ level: 6 }), fs.createWriteStream(targetPath)),
    exitP,
  ]);
};

const runRestoreDrill = async (gzPath, tempDb) => {
  if (!/^[a-zA-Z0-9_]+$/.test(tempDb)) {
    throw new Error(`Invalid temporary database name: ${tempDb}`);
  }
  const env = { ...process.env };
  if (process.env.DB_PASS) env.PGPASSWORD = process.env.DB_PASS;
  const baseArgs = [
    "-h", process.env.DB_HOST || "127.0.0.1",
    "-p", String(process.env.DB_PORT || "5432"),
    "-U", process.env.DB_USER,
  ];

  await runCmd("psql", [...baseArgs, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${tempDb}";`], { env });
  await runCmd("psql", [...baseArgs, "-d", "postgres", "-c", `CREATE DATABASE "${tempDb}";`], { env });

  try {
    const gunzip = zlib.createGunzip();
    const sqlStream = fs.createReadStream(gzPath).pipe(gunzip);
    await runCmd("psql", [...baseArgs, "-d", tempDb, "-v", "ON_ERROR_STOP=1", "-q"], {
      env,
      inputStream: sqlStream,
    });
    const { stdout } = await runCmd(
      "psql",
      [...baseArgs, "-d", tempDb, "-tAc", "SELECT COUNT(*) FROM public.tenants;"],
      { env },
    );
    return { restoredTenants: Number.parseInt(stdout.trim(), 10) || 0 };
  } finally {
    await runCmd("psql", [...baseArgs, "-d", "postgres", "-c", `DROP DATABASE IF EXISTS "${tempDb}";`], { env }).catch(() => {});
  }
};

const run = async () => {
  const opts = parseArgs(process.argv.slice(2));
  const tmpFile = path.join(os.tmpdir(), `qummash-verify-${Date.now()}.sql.gz`);
  let archivePath = opts.file;
  let cleanupTmp = false;

  try {
    if (opts.localDump) {
      console.log("Creating local pg_dump archive for verification...");
      await createLocalDump(tmpFile);
      archivePath = tmpFile;
      cleanupTmp = true;
    } else if (!archivePath) {
      console.log("Downloading latest backup from Cloudflare R2...");
      const meta = await downloadLatestFromR2(tmpFile);
      console.log(`  ✓ Downloaded ${meta.key} (${meta.size} bytes, ${meta.lastModified})`);
      archivePath = tmpFile;
      cleanupTmp = true;
    }

    const stats = await verifyGzipSqlArchive(archivePath);
    console.log(
      `  ✓ Archive verified: ${(stats.totalBytes / 1024).toFixed(1)} KB SQL (pg_dump=${stats.hasPgDumpHeader}, tables=${stats.hasCreateTable})`,
    );

    if (opts.restoreDb) {
      console.log(`Running full PostgreSQL restore drill into temporary DB "${opts.restoreDb}"...`);
      const drill = await runRestoreDrill(archivePath, opts.restoreDb);
      console.log(`  ✓ Restore drill succeeded! Restored tenants: ${drill.restoredTenants} (temp DB dropped)`);
    }
  } finally {
    if (cleanupTmp && fs.existsSync(tmpFile)) {
      await fs.promises.unlink(tmpFile).catch(() => {});
    }
  }
};

run().catch((err) => {
  console.error("Backup verification failed:", err?.message || err);
  process.exit(1);
});
