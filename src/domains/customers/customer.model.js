import { DataTypes } from 'sequelize';
import sequelize from '../../config/database.js';

const Customer = sequelize.define('Customer', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  full_name: {
    type: DataTypes.STRING,
    allowNull: false
  },
  phone: {
    type: DataTypes.STRING,
    allowNull: false
  },
  gender: {
    type: DataTypes.ENUM('M', 'F'),
    defaultValue: 'M'
  },
  address: {
    type: DataTypes.STRING,
    allowNull: true
  },
  type: {
    type: DataTypes.ENUM('Regular', 'VIP', 'Wholesaler'),
    defaultValue: 'Regular'
  },
  notes: {
    type: DataTypes.TEXT,
    allowNull: true
  },
  branch_id: {
    type: DataTypes.INTEGER,
    allowNull: true
  },
  created_by: {
    type: DataTypes.INTEGER,
    allowNull: false
  }
}, {
  tableName: 'customers',
  underscored: true,
  timestamps: true,
  indexes: [
    { name: 'idx_customers_branch', fields: ['branch_id'] },
    { name: 'idx_customers_created_at', fields: ['created_at'] },
    { name: 'idx_customers_phone', fields: ['phone'] },
    { name: 'idx_customers_type', fields: ['type'] }
  ]
});

export default Customer;
