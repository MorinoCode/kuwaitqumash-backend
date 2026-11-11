import { DataTypes } from 'sequelize';
import sequelize from '../../config/database.js';

/**
 * Inventory item for a fabric shop.
 * Stock is tracked in meters (and rolls/pieces), never in weight or karat.
 *   unit = 'meter' | 'roll' | 'piece'
 *   length_m       -> sellable length currently in stock (meters)
 *   roll_length_m  -> length of one roll (meters), optional
 *   cost_per_meter -> purchase cost per meter
 *   price_per_meter -> retail price per meter
 */
const InventoryItem = sequelize.define('InventoryItem', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  rfid_tag: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: true
  },
  barcode: {
    type: DataTypes.STRING(100),
    allowNull: true,
    unique: true
  },
  item_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  item_name_ar: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fabric_type: {
    type: DataTypes.STRING,
    allowNull: false
  },
  composition: {
    type: DataTypes.STRING,
    allowNull: true // e.g. "100% Cotton", "70% Polyester 30% Viscose"
  },
  pattern: {
    type: DataTypes.STRING,
    allowNull: true // e.g. "Floral", "Plain", "Striped"
  },
  color: {
    type: DataTypes.STRING,
    allowNull: true
  },
  width_cm: {
    type: DataTypes.DECIMAL(8, 2),
    allowNull: true
  },
  unit: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'meter',
    validate: {
      isIn: [['meter', 'roll', 'piece']]
    }
  },
  length_m: {
    type: DataTypes.DECIMAL(12, 3),
    allowNull: false,
    defaultValue: 0
  },
  roll_length_m: {
    type: DataTypes.DECIMAL(12, 3),
    allowNull: true
  },
  quantity: {
    type: DataTypes.INTEGER,
    defaultValue: 1
  },
  min_stock_level: {
    type: DataTypes.DECIMAL(12, 3),
    defaultValue: 5,
    allowNull: false
  },
  cost_per_meter: {
    type: DataTypes.DECIMAL(15, 3),
    allowNull: false,
    defaultValue: 0
  },
  price_per_meter: {
    type: DataTypes.DECIMAL(15, 3),
    allowNull: false,
    defaultValue: 0
  },
  supplier_name: {
    type: DataTypes.STRING,
    allowNull: true
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'In Stock',
    validate: {
      isIn: [['In Stock', 'Sold', 'Reserved', 'Out of Stock']]
    }
  },
  branch_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  images: {
    type: DataTypes.ARRAY(DataTypes.STRING),
    defaultValue: [],
    allowNull: true
  },
  description: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  description_ar: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  country_of_origin: {
    type: DataTypes.STRING,
    allowNull: true
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: true
  }
}, {
  tableName: 'inventory_items',
  underscored: true,
  timestamps: true,
  indexes: [
    { name: 'idx_inventory_status', fields: ['status'] },
    { name: 'idx_inventory_branch', fields: ['branch_id'] },
    { name: 'idx_inventory_fabric_type', fields: ['fabric_type'] },
    { name: 'idx_inventory_color', fields: ['color'] },
    { name: 'idx_inventory_created_at', fields: ['created_at'] },
    { name: 'idx_inventory_status_branch', fields: ['status', 'branch_id'] },
    { name: 'idx_inventory_barcode', fields: ['barcode'] },
    { name: 'idx_inventory_item_name', fields: ['item_name'] }
  ]
});

export default InventoryItem;
