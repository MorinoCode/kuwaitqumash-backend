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
      validate: { isIn: [["metal", "category", "subcategory"]] },
    },
    fabric_type: {
      type: DataTypes.STRING,
      allowNull: true, // null for the fabric type itself, required for category/pattern
      comment: "The fabric type this option belongs to (for category/pattern)",
    },
    category: {
      type: DataTypes.STRING,
      allowNull: true, // null for metal and category, required for subcategory
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

// Add schema method for multi-tenant support
// IMPORTANT: The schema is set via search_path in tenant middleware BEFORE this is called
// So we can use the model directly - search_path ensures queries go to the correct schema
// This method exists for consistency with other models that use .schema()
CustomInventoryOption.schema = function (_schemaName) {
  // Return the model itself - search_path is already set by tenant middleware
  // Sequelize will use the current search_path for all queries
  return this;
};

export default CustomInventoryOption;
