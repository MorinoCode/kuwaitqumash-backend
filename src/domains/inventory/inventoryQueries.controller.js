import InventoryItem from "./item.model.js";
import { Op } from "sequelize";;
import logger from "../../utils/logger.js";

export const getInventory = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const {
      branch_id,
      branch_ids,
      search,
      fabric_type,
      pattern,
      color,
      unit,
      country_of_origin,
      status: statusFilter,
      page = 1,
      limit = 50,
    } = req.query;

    const listStatus = statusFilter === "Sold" ? "Sold" : "In Stock";
    const whereClause = { status: listStatus };

    if (req.user.role === "store_owner") {
      if (
        branch_ids &&
        branch_ids.trim() !== "" &&
        branch_ids !== "null" &&
        branch_ids !== "undefined"
      ) {

        const branchIdArray = branch_ids
          .split(",")
          .map((id) => parseInt(id.trim()))
          .filter((id) => !isNaN(id) && id > 0);
        if (branchIdArray.length > 0) {
          whereClause.branch_id = { [Op.in]: branchIdArray };
        }
      } else if (
        branch_id &&
        branch_id !== "null" &&
        branch_id !== "undefined"
      ) {

        whereClause.branch_id = branch_id;
      }
    } else {

      whereClause.branch_id = req.user.branch_id;
    }

    if (fabric_type && fabric_type !== "All") whereClause.fabric_type = fabric_type;
    if (pattern && pattern !== "All") whereClause.pattern = pattern;
    if (color && color !== "All") whereClause.color = color;
    if (unit && unit !== "All") whereClause.unit = unit;
    if (country_of_origin && country_of_origin !== "All")
      whereClause.country_of_origin = country_of_origin;

    if (search) {
      const searchTerm = search.trim();
      if (searchTerm.length > 0) {
        whereClause[Op.or] = [
          { barcode: { [Op.iLike]: `%${searchTerm}%` } },
          { item_name: { [Op.iLike]: `%${searchTerm}%` } },
          { item_name_ar: { [Op.iLike]: `%${searchTerm}%` } },
          { description: { [Op.iLike]: `%${searchTerm}%` } },
        ];
      }
    }

    const MAX_LIMIT = parseInt(process.env.MAX_PAGINATION_LIMIT) || 200;
    const pageNum = parseInt(page, 10) || 1;
    const limitNum = Math.min(parseInt(limit, 10) || 50, MAX_LIMIT);
    const offset = (pageNum - 1) * limitNum;

    const [totalCount, items] = await Promise.all([
      InventoryItem.schema(schema).count({ where: whereClause }),
      InventoryItem.schema(schema).findAll({
        where: whereClause,
        order: [["createdAt", "DESC"]],
        limit: limitNum,
        offset: offset,
      }),
    ]);

    const totalPages = Math.ceil(totalCount / limitNum) || 1;

    const serializedItems = items.map((item) => item.toJSON());

    res.json({
      success: true,
      count: serializedItems.length,
      data: serializedItems,
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
    logger.error("Get Inventory Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to fetch inventory. Please try again." });
  }
};

export const getItemById = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { id } = req.params;
    const item = await InventoryItem.schema(schema).findByPk(id);

    if (!item) {
      return res.status(404).json({ message: "Item not found" });
    }

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied to this item." });
    }

    res.json({ success: true, data: item });
  } catch (error) {
    logger.error("Get Item Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to get item. Please try again." });
  }
};

export const getItemByBarcode = async (req, res) => {
  try {
    const schema = req.tenant.db_schema;
    const { barcode } = req.params;
    const item = await InventoryItem.schema(schema).findOne({
      where: { barcode },
    });

    if (!item) return res.status(404).json({ message: "Item not found" });

    if (
      req.user.role !== "store_owner" &&
      item.branch_id !== req.user.branch_id
    ) {
      return res.status(403).json({ message: "Access denied to this item." });
    }

    res.json({ success: true, data: item });
  } catch (error) {
    logger.error("Get Item By Barcode Error", {
      component: "inventory",
      error: error?.message,
      stack: error?.stack,
    });
    res
      .status(500)
      .json({ message: "Failed to get item by barcode. Please try again." });
  }
};

