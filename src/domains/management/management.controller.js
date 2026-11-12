import { Op } from "sequelize";
import Branch from "../store/branch.model.js";
import User from "../auth/user.model.js";
import Invoice from "../sales/invoice.model.js";
import InvoiceItem from "../sales/invoice-item.model.js";
import InventoryItem from "../inventory/item.model.js";
import Customer from "../customers/customer.model.js";
import logger from "../../utils/logger.js";
import { saveBranchLogo, deleteImage } from "../../utils/fileUpload.js";

export const createBranch = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    let { name, location, phone } = req.body;
    name = name.toLowerCase();

    const existingBranch = await Branch.schema(schema).findOne({ where: { name: { [Op.iLike]: name } } });
    if (existingBranch) {
      return res.status(400).json({ message: "Branch name already exists" });
    }

    const newBranch = await Branch.schema(schema).create({
      name,
      location,
      phone,
      is_main: false,
    });

    res.status(201).json({
      success: true,
      message: "Branch created successfully",
      data: newBranch,
    });
  } catch (error) {
    res.status(400).json({ message: error.message });
  }
};

export const getBranches = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    let whereClause = {};

    if (req.user.role === "branch_manager" || req.user.role === "sales_man") {
      whereClause = { id: req.user.branch_id };
    }

    const branches = await Branch.schema(schema).findAll({
      where: whereClause,
      order: [
        ["is_main", "DESC"],
        ["id", "ASC"],
      ],
    });

    res.json({ success: true, data: branches });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getBranchById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }
    if (
      (req.user.role === "branch_manager" || req.user.role === "sales_man") &&
      branch.id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    res.json({ success: true, data: branch });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const updateBranch = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const {
      name,
      location,
      phone,
      whatsapp_invoice_enabled,
      whatsapp_invoice_to_store_enabled,
      whatsapp_invoice_to_store_phone,
    } = req.body;

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }
    if (
      (req.user.role === "branch_manager" || req.user.role === "sales_man") &&
      branch.id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    let updates = { location, phone };
    if (name) {
      const lowerName = name.toLowerCase();
      if (lowerName !== branch.name.toLowerCase()) {
        const existingBranch = await Branch.schema(schema).findOne({ where: { name: { [Op.iLike]: lowerName } } });
        if (existingBranch) {
          return res.status(400).json({ message: "Branch name already exists" });
        }
      }
      updates.name = lowerName;
    }
    const canManageWhatsappSettings =
      req.user.role === "store_owner" || req.user.role === "branch_manager";

    if (canManageWhatsappSettings) {
      if (whatsapp_invoice_enabled !== undefined)
        updates.whatsapp_invoice_enabled = whatsapp_invoice_enabled;
      if (whatsapp_invoice_to_store_enabled !== undefined)
        updates.whatsapp_invoice_to_store_enabled =
          whatsapp_invoice_to_store_enabled;
      if (whatsapp_invoice_to_store_phone !== undefined)
        updates.whatsapp_invoice_to_store_phone =
          whatsapp_invoice_to_store_phone;
    }
    await branch.update(updates);
    res.json({
      success: true,
      message: "Branch updated successfully",
      data: branch,
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const uploadBranchLogo = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const tenantSlug = req.tenant.slug;

    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    if (req.user.role !== "store_owner" && req.user.role !== "branch_manager") {
      return res.status(403).json({
        message:
          "Access denied. Only store owner and branch manager can upload logo.",
      });
    }
    if (
      req.user.role === "branch_manager" &&
      branch.id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (req.file.size > 5 * 1024 * 1024) {
      return res.status(400).json({ message: "File size exceeds 5MB limit" });
    }

    if (branch.logo_url) {
      try {
        await deleteImage(branch.logo_url);
      } catch (error) {
        logger.warn("Failed to delete old logo", {
          component: "management",
          error: error?.message,
        });
      }
    }

    const logoUrl = await saveBranchLogo(req.file, tenantSlug, id);

    await branch.update({ logo_url: logoUrl });

    await branch.reload();

    res.json({
      success: true,
      message: "Logo uploaded successfully",
      data: { logo_url: branch.logo_url },
    });
  } catch (error) {
    logger.error("Logo upload error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({
      message: error.message || "Failed to upload logo. Please try again.",
    });
  }
};

export const deleteBranchLogo = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) {
      return res.status(404).json({ message: "Branch not found" });
    }

    if (req.user.role !== "store_owner" && req.user.role !== "branch_manager") {
      return res.status(403).json({
        message:
          "Access denied. Only store owner and branch manager can delete logo.",
      });
    }
    if (
      req.user.role === "branch_manager" &&
      branch.id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    if (!branch.logo_url) {
      return res.status(404).json({ message: "No logo found to delete" });
    }

    try {
      await deleteImage(branch.logo_url);
    } catch (error) {
      logger.warn("Failed to delete logo from Cloudinary", {
        component: "management",
        error: error?.message,
      });
    }

    await branch.update({ logo_url: null });

    await branch.reload();

    res.json({
      success: true,
      message: "Logo deleted successfully",
    });
  } catch (error) {
    logger.error("Logo delete error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to delete logo. Please try again." });
  }
};

export const deleteBranch = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const branch = await Branch.schema(schema).findByPk(id);
    if (!branch) return res.status(404).json({ message: "Branch not found" });

    if (branch.is_main) {
      return res
        .status(403)
        .json({ message: "Cannot delete the Main Branch (HQ)." });
    }

    const hasStaff = await User.schema(schema).findOne({
      where: { branch_id: id, is_active: true },
    });
    if (hasStaff) {
      return res.status(400).json({
        message:
          "Cannot delete branch with active staff. Please reassign or deactivate them first.",
      });
    }

    await branch.destroy();
    res.json({ success: true, message: "Branch deleted successfully" });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const createStaff = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    let { full_name, username, password, role, branch_id } = req.body;
    username = username.toLowerCase();

    if (
      req.user.role !== "store_owner" &&
      (role === "store_owner" || role === "branch_manager")
    ) {
      return res.status(403).json({
        message: "Access Denied: You cannot create Admins or Managers.",
      });
    }

    if (req.user.role === "branch_manager") {
      if (parseInt(branch_id) !== req.user.branch_id) {
        return res
          .status(403)
          .json({ message: "You can only add staff to your own branch." });
      }
    }

    const existingUser = await User.schema(schema).findOne({
      where: { username: { [Op.iLike]: username } },
    });
    if (existingUser) {
      return res.status(400).json({ message: "Username already exists" });
    }

    const newUser = await User.schema(schema).create({
      full_name,
      username,
      password: password,
      role,
      branch_id,
      is_active: true,
    });

    res.status(201).json({
      success: true,
      message: "Staff created successfully",
      data: { id: newUser.id, username: newUser.username },
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getStaff = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { page = 1, limit = 50, search } = req.query;
    const whereClause = { is_active: true };

    if (req.user.role === "branch_manager") {
      whereClause.branch_id = req.user.branch_id;
      whereClause.role = { [Op.not]: "store_owner" };
    }

    if (search) {
      whereClause[Op.or] = [
        { full_name: { [Op.iLike]: `%${search}%` } },
        { username: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    const totalCount = await User.schema(schema).count({ where: whereClause });

    const staff = await User.schema(schema).findAll({
      where: whereClause,
      attributes: { exclude: ["password"] },
      include: [
        { model: Branch.schema(schema), as: "branch", attributes: ["name"] },
      ],
      order: [["createdAt", "DESC"]],
      limit: limitNum,
      offset: offset,
    });

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      data: staff,
      pagination: {
        currentPage: pageNum,
        totalPages: totalPages,
        totalItems: totalCount,
        itemsPerPage: limitNum,
        hasNextPage: pageNum < totalPages,
        hasPrevPage: pageNum > 1,
      },
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getStaffById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const staffMember = await User.schema(schema).findByPk(id, {
      attributes: { exclude: ["password"] },
      include: [
        {
          model: Branch.schema(schema),
          as: "branch",
          attributes: ["name", "location"],
        },
      ],
    });

    if (!staffMember)
      return res.status(404).json({ message: "Staff not found" });

    if (
      req.user.role === "branch_manager" &&
      staffMember.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access Denied." });
    }

    const salesHistory = await Invoice.schema(schema).findAll({
      where: { created_by: id },
      include: [
        {
          model: Customer.schema(schema),
          as: "customer",
          attributes: ["full_name", "phone"],
        },
      ],
      order: [["createdAt", "DESC"]],
      limit: 50,
    });

    let totalSales = 0;
    salesHistory.forEach((inv) => {
      totalSales += parseFloat(inv.total_amount);
    });

    res.json({
      success: true,
      data: {
        staff: staffMember,
        history: salesHistory,
        stats: {
          total_sales_volume: totalSales.toFixed(3),
          total_invoices: salesHistory.length,
        },
      },
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getStaffAnalytics = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const staffMember = await User.schema(schema).findByPk(id, {
      attributes: { exclude: ["password"] },
    });

    if (!staffMember)
      return res.status(404).json({ message: "Staff not found" });

    if (
      req.user.role === "branch_manager" &&
      staffMember.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access Denied." });
    }

    const invoices = await Invoice.schema(schema).findAll({
      where: { created_by: id, status: "Paid" },
      include: [
        {
          model: InvoiceItem.schema(schema),
          as: "items",
          include: [
            {
              model: InventoryItem.schema(schema),
              as: "inventory_item",
              attributes: ["fabric_type"],
            },
          ],
        },
      ],
      order: [["createdAt", "ASC"]],
    });

    if (invoices.length === 0) {
      return res.json({
        success: true,
        data: {
          analysis: {
            performance_level: "new_staff",
            insights: [],
            preferences: {},
            behavior: {},
          },
        },
      });
    }

    let totalSales = 0;
    let totalItems = 0;
    let totalMeters = 0;
    let totalProfit = 0;
    const fabricCount = {};
    const patternCount = {};
    const saleDates = [];
    const saleAmounts = [];
    const dayOfWeekCount = {};
    const monthCount = {};
    const customerCount = {};

    invoices.forEach((inv) => {
      totalSales += parseFloat(inv.total_amount || 0);
      saleAmounts.push(parseFloat(inv.total_amount || 0));
      saleDates.push(new Date(inv.createdAt));

      const dayOfWeek = new Date(inv.createdAt).getDay();
      dayOfWeekCount[dayOfWeek] = (dayOfWeekCount[dayOfWeek] || 0) + 1;

      const month = new Date(inv.createdAt).getMonth();
      monthCount[month] = (monthCount[month] || 0) + 1;

      if (inv.customer_id) {
        customerCount[inv.customer_id] =
          (customerCount[inv.customer_id] || 0) + 1;
      }

      inv.items.forEach((item) => {
        totalItems += parseInt(item.quantity || 1);
        totalMeters += parseFloat(item.meters || 0) * (parseInt(item.quantity, 10) || 1);

        const fabricType =
        item.fabric_type || item.inventory_item?.fabric_type || "Other";
        if (fabricType) {
          fabricCount[fabricType] =
            (fabricCount[fabricType] || 0) + parseInt(item.quantity || 1);
        }

        const pattern = item.inventory_item?.pattern;
        if (pattern) {
          patternCount[pattern] =
            (patternCount[pattern] || 0) + parseInt(item.quantity || 1);
        }

        const buyPrice = parseFloat(item.buy_price_snapshot || 0);
        const sellPrice = parseFloat(item.total_price || 0);
        const itemWeight = parseFloat(item.weight || 0);
        totalProfit += sellPrice - buyPrice * itemWeight;
      });
    });

    const preferredFabric = Object.keys(fabricCount).reduce((a, b) =>
      fabricCount[a] > fabricCount[b] ? a : b,
    );

    const preferredPattern = Object.keys(patternCount).reduce((a, b) =>
      patternCount[a] > patternCount[b] ? a : b,
    );

    const avgSaleValue = totalSales / invoices.length;

    let avgDaysBetweenSales = 0;
    if (saleDates.length > 1) {
      const daysBetween = [];
      for (let i = 1; i < saleDates.length; i++) {
        const diff = (saleDates[i] - saleDates[i - 1]) / (1000 * 60 * 60 * 24);
        daysBetween.push(diff);
      }
      avgDaysBetweenSales =
        daysBetween.reduce((a, b) => a + b, 0) / daysBetween.length;
    }

    const bestDayOfWeek = Object.keys(dayOfWeekCount).reduce((a, b) =>
      dayOfWeekCount[a] > dayOfWeekCount[b] ? a : b,
    );
    const dayNames = [
      "Sunday",
      "Monday",
      "Tuesday",
      "Wednesday",
      "Thursday",
      "Friday",
      "Saturday",
    ];

    const bestMonth = Object.keys(monthCount).reduce((a, b) =>
      monthCount[a] > monthCount[b] ? a : b,
    );
    const monthNames = [
      "January",
      "February",
      "March",
      "April",
      "May",
      "June",
      "July",
      "August",
      "September",
      "October",
      "November",
      "December",
    ];

    const uniqueCustomers = Object.keys(customerCount).length;

    let performanceLevel = "new_staff";
    if (invoices.length >= 50) {
      performanceLevel = "top_performer";
    } else if (invoices.length >= 20) {
      performanceLevel = "good_performer";
    } else if (invoices.length >= 10) {
      performanceLevel = "average_performer";
    } else if (invoices.length >= 3) {
      performanceLevel = "developing_staff";
    }

    const insights = [];

    if (invoices.length >= 20) {
      insights.push("high_volume_seller");
    }

    if (preferredFabric) {
      insights.push(`sells_mostly_${preferredFabric}`);
    }

    if (avgDaysBetweenSales > 0 && avgDaysBetweenSales < 7) {
      insights.push("very_active");
    }

    if (avgSaleValue > 200) {
      insights.push("high_value_sales");
    }

    if (totalProfit / totalSales > 0.3) {
      insights.push("profitable_seller");
    }

    if (uniqueCustomers > invoices.length * 0.5) {
      insights.push("good_customer_retention");
    }

    const recentMonths = saleDates.slice(-3).map((d) => new Date(d).getMonth());
    const uniqueMonths = [...new Set(recentMonths)];
    if (uniqueMonths.length === 3 && invoices.length >= 10) {
      insights.push("consistent_performer");
    }

    res.json({
      success: true,
      data: {
        analysis: {
          performance_level: performanceLevel,
          insights: insights,
          preferences: {
            preferred_fabric_type: preferredFabric || null,
            preferred_pattern: preferredPattern || null,
            fabric_distribution: fabricCount,
            pattern_distribution: patternCount,
          },
          behavior: {
            total_sales: totalSales.toFixed(3),
            total_items: totalItems,
            total_meters: totalMeters.toFixed(2),
            total_profit: totalProfit.toFixed(3),
            avg_sale_value: avgSaleValue.toFixed(3),
            avg_days_between_sales: Math.round(avgDaysBetweenSales),
            best_selling_day: dayNames[bestDayOfWeek] || null,
            best_selling_month: monthNames[bestMonth] || null,
            total_invoices: invoices.length,
            unique_customers: uniqueCustomers,
            last_sale:
              saleDates.length > 0 ? saleDates[saleDates.length - 1] : null,
            first_sale: saleDates.length > 0 ? saleDates[0] : null,
          },
        },
      },
    });
  } catch (error) {
    logger.error("Staff Analytics Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process analytics. Please try again." });
  }
};

export const updateStaff = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    let { full_name, username, password, role, branch_id, is_active } =
      req.body;

    const staff = await User.schema(schema).findByPk(id);
    if (!staff) {
      return res.status(404).json({ message: "Staff not found" });
    }

    if (req.user.role !== "store_owner") {
      if (role && role !== staff.role) {
        return res.status(403).json({ message: "Only Store Owner can change roles." });
      }
      if (staff.id !== req.user.id && (staff.role === "store_owner" || staff.role === "branch_manager")) {
        return res
          .status(403)
          .json({ message: "Cannot modify Admins or other Managers." });
      }
    }

    if (req.user.role === "branch_manager") {
      if (staff.branch_id !== req.user.branch_id) {
        return res
          .status(403)
          .json({ message: "Access Denied: Not in your branch." });
      }
      if (branch_id && parseInt(branch_id) !== req.user.branch_id) {
        return res
          .status(403)
          .json({ message: "Cannot move staff to another branch." });
      }
    }

    if (username) {
      username = username.toLowerCase();
      if (username !== staff.username) {
        const existingUser = await User.schema(schema).findOne({ where: { username: { [Op.iLike]: username } } });
        if (existingUser) {
          return res.status(400).json({ message: "Username already exists" });
        }
      }
    }

    staff.full_name = full_name || staff.full_name;
    staff.username = username || staff.username;
    staff.role = role || staff.role;
    staff.branch_id = branch_id || staff.branch_id;
    if (is_active !== undefined) staff.is_active = is_active;

    if (password) {
      staff.password = password;
    }

    await staff.save();

    res.json({
      success: true,
      message: "Staff updated successfully",
      data: { id: staff.id, username: staff.username },
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const deleteStaff = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    if (parseInt(id) === req.user.id) {
      return res
        .status(400)
        .json({ message: "You cannot delete your own account." });
    }

    const staff = await User.schema(schema).findByPk(id);

    if (!staff) return res.status(404).json({ message: "Staff not found" });

    if (staff.role === "store_owner") {
      return res
        .status(403)
        .json({ message: "CRITICAL: Cannot delete the Store Owner account." });
    }

    if (
      req.user.role === "branch_manager" &&
      staff.branch_id !== req.user.branch_id
    ) {
      return res
        .status(403)
        .json({ message: "Access Denied: Not in your branch." });
    }

    staff.is_active = false;
    await staff.save();

    res.json({
      success: true,
      message: "Staff account deactivated successfully.",
    });
  } catch (error) {
    logger.error("Management Error", {
      component: "management",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};
