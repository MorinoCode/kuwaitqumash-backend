import { DataTypes } from "sequelize";
import sequelize from "../../config/database.js";

const CustomInventoryOption = sequelize.define(
  "CustomInventoryOption",
  {
    id: {
      type: DataTypes.INTEGER,
      primaryKey: true,
      autoIncrement: true,
    },
    type: {
      type: DataTypes.STRING(20),
      allowNull: false,
      validate: { isIn: [["fabric", "category", "pattern"]] },
    },
    fabric_type: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "The fabric type this option belongs to (for category/pattern)",
    },
    category: {
      type: DataTypes.STRING,
      allowNull: true,
      comment: "The category this subcategory belongs to",
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
      comment: "The custom option name",
    },
    name_ar: {
      type: DataTypes.STRING(100),
      allowNull: true,
      comment: "Arabic name for the custom option",
    },
    created_by: {
      type: DataTypes.INTEGER,
      allowNull: true,
      comment: "User who created this custom option",
    },
  },
  {
    tableName: "custom_inventory_options",
    underscored: true,
    timestamps: true,
    indexes: [
      {
        name: "idx_custom_option_type_fabric",
        fields: ["type", "fabric_type"],
        unique: false,
      },
      {
        name: "idx_custom_option_type_category",
        fields: ["type", "fabric_type", "category"],
        unique: false,
      },
      {
        name: "idx_custom_option_unique",
        fields: ["type", "fabric_type", "category", "name"],
        unique: true,
      },
    ],
  }
);

CustomInventoryOption.schema = function (_schemaName) {

  return this;
};

export default CustomInventoryOption;
