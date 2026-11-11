import { DataTypes } from "sequelize";
import sequelize from "../../config/database.js";

const RefundPayment = sequelize.define(
  "RefundPayment",
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
    method: {
      type: DataTypes.ENUM("Cash", "K-Net", "Visa/Master", "Link", "Cheque"),
      allowNull: false,
    },
    amount: {
      type: DataTypes.DECIMAL(15, 3),
      allowNull: false,
    },
    reference_number: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    tableName: "refund_payments",
    underscored: true,
    timestamps: true,
    indexes: [{ name: "idx_refund_payments_refund", fields: ["refund_id"] }],
  }
);

export default RefundPayment;
