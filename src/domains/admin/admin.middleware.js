import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { cacheGet, cacheSet } from "../../config/redis.js";
import logger from "../../utils/logger.js";

export const getAdminJwtSecret = () =>
  process.env.ADMIN_JWT_SECRET || process.env.JWT_SECRET;

export const hashToken = (token) =>
  crypto.createHash("sha256").update(String(token)).digest("hex");

export const getAdminRevocationKey = (decoded, rawToken) =>
  `revoked:admin:${decoded?.jti || hashToken(rawToken)}`;

export const revokeAdminToken = async (decoded, rawToken) => {
  const nowSec = Math.floor(Date.now() / 1000);
  const ttlSeconds = Math.max(60, (decoded?.exp || nowSec + 3600) - nowSec);
  await cacheSet(getAdminRevocationKey(decoded, rawToken), true, ttlSeconds);
};

export const extractBearerToken = (req) => {
  const authHeader = req.headers?.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return null;
};

export const protectAdmin = async (req, res, next) => {
  try {
    const token = extractBearerToken(req);
    if (!token) {
      return res
        .status(401)
        .json({ message: "Not authorized, no admin token provided." });
    }

    const secret = getAdminJwtSecret();
    if (!secret) {
      return res
        .status(500)
        .json({ message: "Admin authentication secret is not configured." });
    }

    const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
    if (decoded?.type !== "admin" || decoded?.role !== "super_admin") {
      return res
        .status(403)
        .json({ message: "Forbidden: admin privileges required." });
    }

    const revoked = await cacheGet(getAdminRevocationKey(decoded, token));
    if (revoked) {
      return res
        .status(401)
        .json({ message: "Admin session has been revoked." });
    }

    req.admin = {
      id: decoded.id,
      email: decoded.email,
      full_name: decoded.full_name || "Platform Admin",
      role: decoded.role,
    };
    req.adminToken = token;
    req.adminTokenDecoded = decoded;
    next();
  } catch (error) {
    logger.warn("Admin auth verification failed", {
      component: "admin.middleware",
      error: error?.message,
    });
    return res
      .status(401)
      .json({ message: "Not authorized, admin token failed." });
  }
};

