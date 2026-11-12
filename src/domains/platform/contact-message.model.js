import { DataTypes } from 'sequelize';
import sequelize from '../../config/database.js';

const ContactMessage = sequelize.define('ContactMessage', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true
  },
  name: {
    type: DataTypes.STRING(100),
    allowNull: false
  },
  contact: {
    type: DataTypes.STRING(150),
    allowNull: false
  },
  message: {
    type: DataTypes.TEXT,
    allowNull: false
  },
  status: {
    type: DataTypes.STRING(20),
    allowNull: false,
    defaultValue: 'new',
    validate: {
      isIn: [['new', 'read']]
    }
  }
}, {
  tableName: 'contact_messages',
  underscored: true,
  timestamps: true,
  indexes: [
    { name: 'idx_contact_messages_status', fields: ['status'] },
    { name: 'idx_contact_messages_created_at', fields: ['created_at'] }
  ]
});

export default ContactMessage;
