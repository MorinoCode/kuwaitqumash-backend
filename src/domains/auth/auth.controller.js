import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import { Op } from "sequelize";
import User from "./user.model.js";
import Branch from "../store/branch.model.js";
import logger from "../../utils/logger.js";

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: "24h",
  });
};

export const login = async (req, res) => {
  try {
    let { username, password } = req.body; // validated & sanitized by Zod
    username = username.toLowerCase();
    const schema = req.tenant.db_schema;

    const user = await User.schema(schema).findOne({
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
      // Prevent timing attacks by running bcrypt even if user not found
      // $2b$10$abcdefghijklmnopqrstuv is a valid salt format
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

    const token = generateToken(user.id);

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

export const logout = (req, res) => {
  const isProduction = process.env.NODE_ENV === "production";

  // Options must match the login cookie EXACTLY to clear it successfully
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
