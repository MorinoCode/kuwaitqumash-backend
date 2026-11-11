import { DataTypes } from 'sequelize';
import sequelize from '../../config/database.js';

const InvoiceItem = sequelize.define('InvoiceItem', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  invoice_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  inventory_item_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  quantity: {
    type: DataTypes.INTEGER,
    allowNull: false,
    defaultValue: 1
  },
  barcode: {
    type: DataTypes.STRING,
    allowNull: true
  },
  item_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  item_name_ar: {
    type: DataTypes.STRING,
    allowNull: true
  },
  fabric_type: {
    type: DataTypes.STRING,
    allowNull: true
  },
  color: {
    type: DataTypes.STRING,
    allowNull: true
  },
  unit: {
    type: DataTypes.STRING,
    allowNull: false,
    defaultValue: 'meter'
  },
  meters: {
    type: DataTypes.DECIMAL(12, 3),
    allowNull: false,
    defaultValue: 0
  },
  cost_per_meter_snapshot: {
    type: DataTypes.DECIMAL(15, 3),
    allowNull: false,
    defaultValue: 0
  },
  price_per_meter: {
    type: DataTypes.DECIMAL(15, 3),
    allowNull: false,
    defaultValue: 0
  },
  discount: {
    type: DataTypes.DECIMAL(15, 3),
    defaultValue: 0
  },
  total_price: {
    type: DataTypes.DECIMAL(15, 3),
    allowNull: false
  }
}, {
  tableName: 'invoice_items',
  underscored: true,
  timestamps: false
});

export default InvoiceItem;
