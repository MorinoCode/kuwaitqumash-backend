import { DataTypes } from "sequelize";
import sequelize from "../../config/database.js";

const Branch = sequelize.define(
  "Branch",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    location: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    is_main: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    manager_id: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    whatsapp_invoice_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    whatsapp_invoice_to_store_enabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    whatsapp_invoice_to_store_phone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    logo_url: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    next_invoice_sequence: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    tableName: "branches",
    underscored: true,
    timestamps: true,
  },
);

export default Branch;
