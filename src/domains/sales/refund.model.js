import { DataTypes } from "sequelize";
import sequelize from "../../config/database.js";

const Refund = sequelize.define(
  "Refund",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    invoice_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    refund_number: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    credit_note_number: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    total_amount: {
      type: DataTypes.DECIMAL(15, 3),
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      defaultValue: "Completed",
      validate: {
        isIn: [["Completed", "Pending", "Cancelled"]],
      },
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    branch_id: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
  },
  {
    tableName: "refunds",
    underscored: true,
    timestamps: true,
    indexes: [
      { name: "idx_refunds_invoice", fields: ["invoice_id"] },
      { name: "idx_refunds_branch", fields: ["branch_id"] },
      { name: "idx_refunds_created_at", fields: ["created_at"] },
    ],
  }
);

export default Refund;
