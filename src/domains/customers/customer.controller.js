import Customer from "./customer.model.js";
import Invoice from "../sales/invoice.model.js";
import sequelize from "../../config/database.js";
import InvoiceItem from "../sales/invoice-item.model.js";
import InventoryItem from "../inventory/item.model.js";
import { Op } from "sequelize";
import fs from "fs";
import sharp from "sharp";
import OpenAI from "openai";
import { saveImage, deleteImage } from "../../utils/fileUpload.js";
import { normalizeToLatinDigits } from "../../utils/normalizeNumbers.js";
import logger from "../../utils/logger.js";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

export const createCustomer = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const tenantId = req.tenant.id;

    const {
      full_name,
      phone,
      civil_id: rawCivilId,
      nationality,
      address,
      notes,
      branch_id,
      gender,
      birth_date,
      expiry_date,
      type,
    } = req.body;

    const civil_id =
      rawCivilId != null
        ? normalizeToLatinDigits(String(rawCivilId).trim())
        : rawCivilId;
    const phoneNormalized =
      phone != null ? normalizeToLatinDigits(String(phone)) : phone;

    const existingCustomer = await Customer.schema(schema).findOne({
      where: { civil_id: civil_id || null },
    });
    if (existingCustomer && civil_id) {
      return res
        .status(400)
        .json({ message: "Customer with this Civil ID already exists." });
    }

    let id_card_front_url = null;
    let id_card_back_url = null;

    const store = req.tenant.slug || `tenant_${tenantId}`;
    let customerFolder =
      civil_id && String(civil_id).trim()
        ? String(civil_id)
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .replace(/_+/g, "_")
        : "";
    if (!customerFolder)
      customerFolder = `cust_${Date.now()}_${Math.round(Math.random() * 1e9)}`;

    if (req.files && req.files.front_image) {
      id_card_front_url = await saveImage(
        req.files.front_image[0],
        "customers",
        customerFolder,
        store
      );
    }
    if (req.files && req.files.back_image) {
      id_card_back_url = await saveImage(
        req.files.back_image[0],
        "customers",
        customerFolder,
        store
      );
    }

    const finalBranchId =
      req.user.role === "store_owner" && branch_id
        ? branch_id
        : req.user.branch_id;

    const newCustomer = await Customer.schema(schema).create({
      full_name,
      phone: phoneNormalized,
      civil_id,
      nationality,
      address,
      gender,
      birth_date,
      expiry_date,
      type: type || "Regular",
      notes,
      id_card_front_url,
      id_card_back_url,
      branch_id: finalBranchId,
      created_by: req.user.id,
    });

    res.status(201).json({
      success: true,
      message: "Customer registered successfully",
      data: newCustomer,
    });
  } catch (error) {
    logger.error("Create customer error", {
      component: "customers",
      error: error?.message,
      stack: error?.stack,
      requestId: req.requestId,
    });
    res
      .status(500)
      .json({ message: "Failed to create customer. Please try again." });
  }
};

export const getCustomers = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { search, branch_id, page = 1, limit = 20 } = req.query;
    const whereClause = {};

    if (req.user.role !== "store_owner") {
      whereClause.branch_id = req.user.branch_id;
    } else if (branch_id) {
      whereClause.branch_id = branch_id;
    }

    if (search) {
      whereClause[Op.or] = [
        { full_name: { [Op.iLike]: `%${search}%` } },
        { phone: { [Op.like]: `%${search}%` } },
        { civil_id: { [Op.like]: `%${search}%` } },
      ];
    }

    // Parse pagination parameters
    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    // Get total count for pagination
    const totalCount = await Customer.schema(schema).count({
      where: whereClause,
    });

    const listAttributes = [
      "id",
      "full_name",
      "phone",
      "civil_id",
      "type",
      "branch_id",
      "created_at",
      "id_card_front_url",
      "id_card_back_url",
    ];
    const customers = await Customer.schema(schema).findAll({
      where: whereClause,
      attributes: listAttributes,
      order: [["createdAt", "DESC"]],
      limit: limitNum,
      offset: offset,
    });

    const totalPages = Math.ceil(totalCount / limitNum);

    res.json({
      success: true,
      data: customers,
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
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const getCustomerById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const customer = await Customer.schema(schema).findByPk(id);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const statsQuery = await Invoice.schema(schema).findOne({
      where: { customer_id: id },
      attributes: [
        [sequelize.fn("COUNT", sequelize.col("id")), "invoice_count"],
        [sequelize.fn("SUM", sequelize.col("total_amount")), "total_spent"],
        [sequelize.fn("MAX", sequelize.col("createdAt")), "last_purchase"]
      ],
      raw: true
    });

    const history = await Invoice.schema(schema).findAll({
      where: { customer_id: id },
      include: ["items"],
      order: [["createdAt", "DESC"]],
      limit: 10
    });

    res.json({
      success: true,
      data: {
        customer,
        history,
        stats: {
          total_spent: parseFloat(statsQuery?.total_spent || 0).toFixed(3),
          invoice_count: parseInt(statsQuery?.invoice_count || 0),
          last_purchase: statsQuery?.last_purchase || null,
        },
      },
    });
  } catch (error) {
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

// Customer AI Analytics - Comprehensive analysis
export const getCustomerAnalytics = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const customer = await Customer.schema(schema).findByPk(id);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    // Get all invoices with items
    const invoices = await Invoice.schema(schema).findAll({
      where: { customer_id: id, status: "Paid" },
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
            customer_type: "new_customer",
            insights: [],
            preferences: {},
            behavior: {},
          },
        },
      });
    }

    // Calculate analytics
    let totalSpent = 0;
    let totalItems = 0;
    let totalMeters = 0;
    let totalProfit = 0;
    const fabricCount = {};
    const categoryCount = {};
    const purchaseDates = [];
    const purchaseAmounts = [];
    const dayOfWeekCount = {};
    const monthCount = {};

    invoices.forEach((inv) => {
      totalSpent += parseFloat(inv.total_amount || 0);
      purchaseAmounts.push(parseFloat(inv.total_amount || 0));
      purchaseDates.push(new Date(inv.createdAt));

      // Day of week analysis
      const dayOfWeek = new Date(inv.createdAt).getDay();
      dayOfWeekCount[dayOfWeek] = (dayOfWeekCount[dayOfWeek] || 0) + 1;

      // Month analysis
      const month = new Date(inv.createdAt).getMonth();
      monthCount[month] = (monthCount[month] || 0) + 1;

      inv.items.forEach((item) => {
        totalItems += parseInt(item.quantity || 1);
        totalMeters += parseFloat(item.meters || 0) * (parseInt(item.quantity, 10) || 1);

        // Karat preference
        const fabricType =
      item.fabric_type || item.inventory_item?.fabric_type || "Other";
        if (fabricType) {
          fabricCount[fabricType] =
            (fabricCount[fabricType] || 0) + parseInt(item.quantity || 1);
        }

        // Category preference
        const category = item.inventory_item?.category;
        if (category) {
          categoryCount[category] =
            (categoryCount[category] || 0) + parseInt(item.quantity || 1);
        }

        // Profit calculation
        const buyPrice = parseFloat(item.buy_price_snapshot || 0);
        const sellPrice = parseFloat(item.total_price || 0);
        const itemWeight = parseFloat(item.weight || 0);
        totalProfit += sellPrice - buyPrice * itemWeight;
      });
    });

    // Find preferred fabric type
    const preferredFabric = Object.keys(fabricCount).reduce((a, b) =>
      fabricCount[a] > fabricCount[b] ? a : b
    );

    // Find preferred category
    const preferredCategory = Object.keys(categoryCount).reduce((a, b) =>
      categoryCount[a] > categoryCount[b] ? a : b
    );

    // Calculate average purchase value
    const avgPurchaseValue = totalSpent / invoices.length;

    // Calculate purchase frequency (days between purchases)
    let avgDaysBetweenPurchases = 0;
    if (purchaseDates.length > 1) {
      const daysBetween = [];
      for (let i = 1; i < purchaseDates.length; i++) {
        const diff =
          (purchaseDates[i] - purchaseDates[i - 1]) / (1000 * 60 * 60 * 24);
        daysBetween.push(diff);
      }
      avgDaysBetweenPurchases =
        daysBetween.reduce((a, b) => a + b, 0) / daysBetween.length;
    }

    // Find best buying day
    const bestDayOfWeek = Object.keys(dayOfWeekCount).reduce((a, b) =>
      dayOfWeekCount[a] > dayOfWeekCount[b] ? a : b
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

    // Find best buying month
    const bestMonth = Object.keys(monthCount).reduce((a, b) =>
      monthCount[a] > monthCount[b] ? a : b
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

    // Determine customer type
    let customerType = "new_customer";
    if (invoices.length >= 10) {
      customerType = "vip_customer";
    } else if (invoices.length >= 5) {
      customerType = "regular_customer";
    } else if (invoices.length >= 2) {
      customerType = "returning_customer";
    }

    // Generate insights
    const insights = [];

    if (invoices.length >= 3) {
      insights.push("frequent_buyer");
    }

    if (preferredFabric) {
      insights.push(`prefers_${preferredFabric}_items`);
    }

    if (avgDaysBetweenPurchases > 0 && avgDaysBetweenPurchases < 30) {
      insights.push("active_shopper");
    }

    if (avgPurchaseValue > 100) {
      insights.push("high_value_customer");
    }

    if (totalProfit / totalSpent > 0.3) {
      insights.push("profitable_customer");
    }

    // Holiday/seasonal buying pattern
    const recentMonths = purchaseDates
      .slice(-3)
      .map((d) => new Date(d).getMonth());
    const uniqueMonths = [...new Set(recentMonths)];
    if (uniqueMonths.length === 3) {
      insights.push("consistent_buyer");
    }

    // Check if likely to buy during holidays (Nov, Dec, Jan for holidays)
    const holidayMonths = [10, 11, 0]; // Nov, Dec, Jan
    const holidayPurchases = purchaseDates.filter((d) =>
      holidayMonths.includes(new Date(d).getMonth())
    ).length;
    if (holidayPurchases > purchaseDates.length * 0.4) {
      insights.push("holiday_shopper");
    }

    res.json({
      success: true,
      data: {
        analysis: {
          customer_type: customerType,
          insights: insights,
          preferences: {
            preferred_fabric_type: preferredFabric ? preferredFabric : null,
            preferred_category: preferredCategory || null,
            fabric_distribution: fabricCount,
            category_distribution: categoryCount,
          },
          behavior: {
            total_spent: totalSpent.toFixed(3),
            total_items: totalItems,
            total_meters: totalMeters.toFixed(2),
            total_profit: totalProfit.toFixed(3),
            avg_purchase_value: avgPurchaseValue.toFixed(3),
            avg_days_between_purchases: Math.round(avgDaysBetweenPurchases),
            best_buying_day: dayNames[bestDayOfWeek] || null,
            best_buying_month: monthNames[bestMonth] || null,
            purchase_frequency: invoices.length,
            last_purchase:
              purchaseDates.length > 0
                ? purchaseDates[purchaseDates.length - 1]
                : null,
            first_purchase: purchaseDates.length > 0 ? purchaseDates[0] : null,
          },
        },
      },
    });
  } catch (error) {
    logger.error("Customer Analytics Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process analytics. Please try again." });
  }
};

export const updateCustomer = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const tenantId = req.tenant.id;
    const { id } = req.params;

    const customer = await Customer.schema(schema).findByPk(id);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const updateData = { ...req.body };
    if (updateData.civil_id != null)
      updateData.civil_id = normalizeToLatinDigits(
        String(updateData.civil_id).trim()
      );
    if (updateData.phone != null)
      updateData.phone = normalizeToLatinDigits(String(updateData.phone));
    const store = req.tenant.slug || `tenant_${tenantId}`;
    const customerFolder =
      customer.civil_id && String(customer.civil_id).trim()
        ? String(customer.civil_id)
            .replace(/[^a-zA-Z0-9_-]/g, "_")
            .replace(/_+/g, "_")
        : `cust_${customer.id}`;

    if (req.files && req.files.front_image) {
      if (customer.id_card_front_url)
        await deleteImage(customer.id_card_front_url);
      updateData.id_card_front_url = await saveImage(
        req.files.front_image[0],
        "customers",
        customerFolder,
        store
      );
    }
    if (req.files && req.files.back_image) {
      if (customer.id_card_back_url)
        await deleteImage(customer.id_card_back_url);
      updateData.id_card_back_url = await saveImage(
        req.files.back_image[0],
        "customers",
        customerFolder,
        store
      );
    }

    await customer.update(updateData);
    res.json({
      success: true,
      message: "Updated successfully",
      data: customer,
    });
  } catch (error) {
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const deleteCustomer = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const customer = await Customer.schema(schema).findByPk(id);

    if (!customer)
      return res.status(404).json({ message: "Customer not found" });

    if (
      req.user.role !== "store_owner" &&
      customer.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied." });
    }

    const hasInvoices = await Invoice.schema(schema).findOne({
      where: { customer_id: id },
    });
    if (hasInvoices) {
      return res
        .status(400)
        .json({ message: "Cannot delete customer with purchase history." });
    }

    if (customer.id_card_front_url)
      await deleteImage(customer.id_card_front_url);
    if (customer.id_card_back_url) await deleteImage(customer.id_card_back_url);

    await customer.destroy();
    res.json({ success: true, message: "Deleted successfully" });
  } catch (error) {
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};

export const scanIDCard = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    const imageMetadata = await sharp(req.file.path).metadata();
    
    // Redact the left 35% of the ID card (where the photo is typically located on Kuwait Civil IDs)
    const redactWidth = Math.floor(imageMetadata.width * 0.35);
    const redactHeight = imageMetadata.height;

    const redactedBuffer = await sharp(req.file.path)
      .rotate() // Auto-rotate based on EXIF
      .composite([{
        input: { 
          create: { 
            width: redactWidth, 
            height: redactHeight, 
            channels: 4, 
            background: { r: 0, g: 0, b: 0, alpha: 1 } 
          } 
        },
        top: 0,
        left: 0
      }])
      .jpeg({ quality: 80 })
      .toBuffer();

    const base64Image = redactedBuffer.toString("base64");
    const dataUrl = `data:image/jpeg;base64,${base64Image}`;

    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Extract data from this ID card. If it's the FRONT, extract: 'full_name' (English), 'civil_id', 'nationality', 'gender' (M/F), 'birth_date' (YYYY-MM-DD), 'expiry_date' (YYYY-MM-DD). If it's the BACK, extract the 'address' details (Block, Street, House, etc) into a single string field named 'address'. Return strictly JSON. Use null for fields not found.",
            },
            {
              type: "image_url",
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      max_tokens: 500,
    });

    const content = response.choices[0].message.content;
    const jsonString = content
      .replace(/```json/g, "")
      .replace(/```/g, "")
      .trim();

    let data;
    try {
      data = JSON.parse(jsonString);
    } catch (e) {
      void e;
      return res.status(500).json({ message: "Failed to parse AI response" });
    }

    try {
      if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
    } catch (e) {
      void e;
    }

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    logger.error("AI scan error", {
      component: "customers",
      error: error?.message,
      stack: error?.stack,
    });
    res.status(500).json({ message: "AI Scan failed", error: error?.message });
  }
};

export const getCustomerHistory = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;

    const { page = 1, limit = 20 } = req.query;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 20, 100);
    const offset = (pageNum - 1) * limitNum;

    const { count, rows: history } = await Invoice.schema(schema).findAndCountAll({
      where: { customer_id: id },
      include: ["items"],
      order: [["createdAt", "DESC"]],
      limit: limitNum,
      offset: offset
    });

    res.json({ 
      success: true, 
      data: history,
      pagination: {
        currentPage: pageNum,
        totalPages: Math.ceil(count / limitNum),
        totalItems: count,
        itemsPerPage: limitNum
      }
    });
  } catch (error) {
    logger.error("Customer Error", {
      component: "customer",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to process request. Please try again." });
  }
};
