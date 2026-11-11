import { DataTypes } from 'sequelize';
import sequelize from '../../config/database.js';

const Invoice = sequelize.define('Invoice', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  invoice_number: {
    type: DataTypes.STRING,
    unique: true,
    allowNull: false
  },
  customer_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  total_meters: {
    type: DataTypes.DECIMAL(12, 3),
    allowNull: false,
    defaultValue: 0
  },
  total_discount: {
    type: DataTypes.DECIMAL(15, 3),
    defaultValue: 0
  },
  total_amount: {
    type: DataTypes.DECIMAL(15, 3),
    allowNull: false
  },
  status: {
    type: DataTypes.STRING,
    defaultValue: 'Paid',
    validate: {
      isIn: [['Paid', 'Void', 'Refunded', 'Partially Refunded']]
    }
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  pdf_path: {
    type: DataTypes.STRING,
    allowNull: true
  },
  branch_id: {
    type: DataTypes.INTEGER,
    allowNull: false
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: false
  }
}, {
  tableName: 'invoices',
  underscored: true,
  timestamps: true,
  indexes: [
    { name: 'idx_invoices_branch', fields: ['branch_id'] },
    { name: 'idx_invoices_created_at', fields: ['created_at'] },
    { name: 'idx_invoices_customer', fields: ['customer_id'] },
    { name: 'idx_invoices_status', fields: ['status'] },
    { name: 'idx_invoices_status_created_at', fields: ['status', 'created_at'] }
  ]
});

export default Invoice;
