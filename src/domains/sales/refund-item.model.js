import { DataTypes } from "sequelize";
import sequelize from "../../config/database.js";

const RefundItem = sequelize.define(
  "RefundItem",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    refund_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    invoice_item_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    inventory_item_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    quantity_refunded: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
    amount_refunded: {
      type: DataTypes.DECIMAL(15, 3),
      allowNull: false,
    },
  },
  {
    tableName: "refund_items",
    underscored: true,
    timestamps: false,
    indexes: [
      { name: "idx_refund_items_refund", fields: ["refund_id"] },
      { name: "idx_refund_items_invoice_item", fields: ["invoice_item_id"] },
    ],
  }
);

export default RefundItem;
