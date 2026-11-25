import crypto from "node:crypto";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Op } from "sequelize";
import User from "./user.model.js";
import Branch from "../store/branch.model.js";
import Tenant from "../platform/tenant.model.js";
import { cacheSet } from "../../config/redis.js";
import { invalidateAuthUserCache } from "../../middlewares/auth.middleware.js";
import logger from "../../utils/logger.js";

const generateToken = (user, tenantSlug) => {
  return jwt.sign(
    {
      id: user.id,
      tenant: tenantSlug,
      tv: user.token_version ?? 0,
      jti: crypto.randomUUID(),
    },
    process.env.JWT_SECRET,
    {
      algorithm: "HS256",
      expiresIn: "24h",
    },
  );
};

export const login = async (req, res) => {
  try {
    let { username, password } = req.body;
    username = String(username || "").trim();
    const schema = req.tenant.db_schema;

    let user = await User.schema(schema).findOne({
      where: { username: { [Op.iLike]: username } },
      include: [
        {
          model: Branch.schema(schema),
          as: "branch",
          attributes: ["id", "name", "is_main"],
        },
      ],
    });

    if (!user) {
      user = await User.schema(schema).findOne({
        where: { full_name: { [Op.iLike]: username } },
        include: [
          {
            model: Branch.schema(schema),
            as: "branch",
            attributes: ["id", "name", "is_main"],
          },
        ],
      });
    }

    if (!user) {

      await bcrypt.compare(password, "$2b$10$abcdefghijklmnopqrstuvwxyzaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
      return res.status(401).json({ message: "Invalid credentials." });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials." });
    }

    if (!user.is_active) {
      return res.status(403).json({ message: "Account is disabled." });
    }

    const token = generateToken(user, req.tenant.slug);

    const isProduction = process.env.NODE_ENV === "production";

    const cookieOpts = {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      path: "/",
      maxAge: 24 * 60 * 60 * 1000,
    };

    res.cookie("token", token, cookieOpts);

    const userData = user.toJSON();
    delete userData.password;

    res.json({
      success: true,
      message: "Login successful.",
      data: {
        ...userData,
        token,
        tenant_id: req.tenant.slug,
        tenant_name: req.tenant.name || req.tenant.slug,
      },
    });
  } catch (error) {
    logger.error("Login error", {
      component: "auth",
      message: error?.message,
      code: error?.code,
    });
    res.status(500).json({
      message: "An error occurred during login. Please try again later.",
    });
  }
};

export const logout = async (req, res) => {
  try {
    let token = null;
    if (req.cookies?.token) {
      token = req.cookies.token;
    } else if (
      req.headers?.authorization &&
      req.headers.authorization.startsWith("Bearer ")
    ) {
      token = req.headers.authorization.slice(7).trim();
    }

    if (token && process.env.JWT_SECRET) {
      let decoded = null;
      try {
        decoded = jwt.verify(token, process.env.JWT_SECRET, {
          algorithms: ["HS256"],
        });
      } catch {
        decoded = null;
      }

      if (decoded) {
        const nowSec = Math.floor(Date.now() / 1000);
        const ttl = Math.max(60, (decoded.exp || nowSec + 86400) - nowSec);
        const tokenHash = crypto
          .createHash("sha256")
          .update(String(token))
          .digest("hex");
        await cacheSet(`revoked:jwt:${decoded.jti || tokenHash}`, true, ttl);

        const tenantSlug = decoded.tenant || req.headers?.["x-tenant-id"];
        if (tenantSlug && decoded.id) {
          const tenant = await Tenant.findOne({ where: { slug: tenantSlug } });
          if (tenant && /^[a-zA-Z0-9_]+$/.test(tenant.db_schema)) {
            await User.schema(tenant.db_schema).increment("token_version", {
              by: 1,
              where: { id: decoded.id },
            });
            await invalidateAuthUserCache(tenant.db_schema, decoded.id);
          }
        }
      }
    }
  } catch (error) {
    logger.warn("Failed to revoke session during logout", {
      component: "auth",
      error: error?.message,
    });
  }

  const isProduction = process.env.NODE_ENV === "production";

  res.clearCookie("token", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/",
  });

  res.json({ success: true, message: "Logged out successfully." });
};

export const getMe = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;

    const user = await User.schema(schema).findByPk(req.user.id, {
      attributes: { exclude: ["password"] },
      include: [
        {
          model: Branch.schema(schema),
          as: "branch",
          attributes: ["id", "name", "is_main"],
        },
      ],
    });

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const userData = user.toJSON ? user.toJSON() : user;
    res.json({
      success: true,
      data: {
        ...userData,
        tenant_id: req.tenant.slug,
        tenant_name: req.tenant.name || req.tenant.slug,
      },
    });
  } catch (error) {
    logger.error("GetMe error", {
      component: "auth",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
    });
    res
      .status(500)
      .json({
        message: "Failed to retrieve user information. Please try again.",
      });
  }
};

export const changePassword = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { current_password, new_password } = req.body;

    const user = await User.schema(schema).findByPk(req.user.id);
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await bcrypt.compare(current_password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: "Current password is incorrect." });
    }

    const nextTokenVersion = (user.token_version ?? 0) + 1;
    // Pass plaintext new_password; User model's beforeUpdate hook hashes it once.
    await user.update({
      password: new_password,
      token_version: nextTokenVersion,
    });
    await invalidateAuthUserCache(schema, user.id);

    const token = generateToken(
      { id: user.id, token_version: nextTokenVersion },
      req.tenant.slug,
    );
    const isProduction = process.env.NODE_ENV === "production";
    res.cookie("token", token, {
      httpOnly: true,
      secure: isProduction,
      sameSite: isProduction ? "none" : "lax",
      path: "/",
      maxAge: 24 * 60 * 60 * 1000,
    });

    return res.json({
      success: true,
      message: "Password updated successfully.",
      data: { token },
    });
  } catch (error) {
    logger.error("Change password error", {
      component: "auth",
      userId: req.user?.id,
      error: error?.message,
      requestId: req.requestId,
    });
    return res.status(500).json({
      message: "Failed to change password. Please try again.",
    });
  }
};
