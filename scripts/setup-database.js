/**
 * Database Setup Script
 * 
 * This script creates the database and all necessary schemas/tables
 * Run this script if you lose your database and need to recreate it
 * 
 * Usage: node scripts/setup-database.js
 */

import { Sequelize } from 'sequelize';
import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';

dotenv.config();

// Import models
import Tenant from '../src/domains/platform/tenant.model.js';
import WhatsappConfig from '../src/domains/platform/whatsapp.config.model.js';
import User from '../src/domains/auth/user.model.js';
import Branch from '../src/domains/store/branch.model.js';
import Customer from '../src/domains/customers/customer.model.js';
import InventoryItem from '../src/domains/inventory/item.model.js';
import Invoice from '../src/domains/sales/invoice.model.js';
import InvoiceItem from '../src/domains/sales/invoice-item.model.js';
import InvoicePayment from '../src/domains/sales/payment.model.js';
import Refund from '../src/domains/sales/refund.model.js';
import RefundItem from '../src/domains/sales/refund-item.model.js';
import RefundPayment from '../src/domains/sales/refund-payment.model.js';
import CustomInventoryOption from '../src/domains/inventory/custom-option.model.js';

// Setup relationships (same as in app.js)
User.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
Branch.hasMany(User, { foreignKey: 'branch_id' });

Invoice.belongsTo(Customer, { foreignKey: 'customer_id', as: 'customer' });
Customer.hasMany(Invoice, { foreignKey: 'customer_id' });

Invoice.belongsTo(User, { foreignKey: 'created_by', as: 'creator' });
User.hasMany(Invoice, { foreignKey: 'created_by' });

Invoice.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
Branch.hasMany(Invoice, { foreignKey: 'branch_id' });

Invoice.hasMany(InvoiceItem, { foreignKey: 'invoice_id', as: 'items' });
InvoiceItem.belongsTo(Invoice, { foreignKey: 'invoice_id' });

Invoice.hasMany(InvoicePayment, { foreignKey: 'invoice_id', as: 'payments' });
InvoicePayment.belongsTo(Invoice, { foreignKey: 'invoice_id' });


InventoryItem.belongsTo(Branch, { foreignKey: 'branch_id', as: 'branch' });
Branch.hasMany(InventoryItem, { foreignKey: 'branch_id' });

InvoiceItem.belongsTo(InventoryItem, { foreignKey: 'inventory_item_id', as: 'inventory_item' });
InventoryItem.hasMany(InvoiceItem, { foreignKey: 'inventory_item_id' });

const setupDatabase = async () => {
  let adminConnection = null;
  let appConnection = null;

  try {
    logger.info('Starting database setup', { component: 'setup-database' });

    const dbName = process.env.DB_NAME;
    const dbUser = process.env.DB_USER;
    const dbPass = process.env.DB_PASS;
    const dbHost = process.env.DB_HOST || 'localhost';
    const dbPort = process.env.DB_PORT || 5432;

    if (!dbName || !dbUser || !dbPass) {
      throw new Error('Missing database credentials in .env file');
    }

    logger.info('Connecting to PostgreSQL server', { component: 'setup-database', host: dbHost, port: dbPort });

    adminConnection = new Sequelize('postgres', dbUser, dbPass, {
      host: dbHost,
      port: dbPort,
      dialect: 'postgres',
      logging: false
    });

    await adminConnection.authenticate();
    logger.info('Connected to PostgreSQL server', { component: 'setup-database' });

    try {
      await adminConnection.query(`CREATE DATABASE "${dbName}";`);
      logger.info('Database created', { component: 'setup-database', database: dbName });
    } catch (error) {
      if (error?.message?.includes('already exists')) {
        logger.info('Database already exists', { component: 'setup-database', database: dbName });
      } else {
        throw error;
      }
    }

    await adminConnection.close();

    logger.info('Connecting to application database', { component: 'setup-database', database: dbName });
    appConnection = new Sequelize(dbName, dbUser, dbPass, {
      host: dbHost,
      port: dbPort,
      dialect: 'postgres',
      logging: false,
      pool: {
        max: 5,
        min: 0,
        acquire: 30000,
        idle: 10000
      }
    });

    await appConnection.authenticate();
    logger.info('Connected to application database', { component: 'setup-database' });

    await appConnection.query("SET search_path TO public");
    await Tenant.sync({ force: false, alter: true });
    await WhatsappConfig.sync({ force: false, alter: true });
    logger.info('Public schema tables created', { component: 'setup-database' });

    const tenants = await Tenant.findAll();
    if (tenants.length > 0) {
      logger.info('Syncing tenant schemas', { component: 'setup-database', count: tenants.length });
      for (const tenant of tenants) {
        const schema = tenant.db_schema;
        await appConnection.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";`);
        await appConnection.query(`SET search_path TO "${schema}", public`);
        await Branch.schema(schema).sync({ force: false, alter: true });
        await User.schema(schema).sync({ force: false, alter: true });
        await Customer.schema(schema).sync({ force: false, alter: true });
        await InventoryItem.schema(schema).sync({ force: false, alter: true });
        await Invoice.schema(schema).sync({ force: false, alter: true });
        await InvoiceItem.schema(schema).sync({ force: false, alter: true });
        await InvoicePayment.schema(schema).sync({ force: false, alter: true });
        await CustomInventoryOption.schema(schema).sync({ force: false, alter: true });
        await Refund.schema(schema).sync({ force: false, alter: true });
        await RefundItem.schema(schema).sync({ force: false, alter: true });
        await RefundPayment.schema(schema).sync({ force: false, alter: true });
        logger.info('Schema synced', { component: 'setup-database', schema });
      }
    } else {
      logger.info('No tenants found. Register a new store after setup.', { component: 'setup-database' });
    }

    try {
      await appConnection.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";');
      logger.info('UUID extension enabled', { component: 'setup-database' });
    } catch (error) {
      void error;
      logger.info('UUID extension already exists or not needed', { component: 'setup-database' });
    }

    logger.info('Database setup completed. Next: npm start, /api/platform/register, or restore backup.', {
      component: 'setup-database'
    });

    await appConnection.close();
    process.exit(0);

  } catch (error) {
    logger.error('Database setup error', {
      component: 'setup-database',
      error: error?.message,
      stack: error?.stack
    });
    
    if (adminConnection) await adminConnection.close();
    if (appConnection) await appConnection.close();
    
    process.exit(1);
  }
};

// Run the setup
setupDatabase();
