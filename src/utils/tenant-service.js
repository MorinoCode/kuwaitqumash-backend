import sequelize from '../config/database.js';
import bcrypt from 'bcrypt';
import logger from './logger.js';
import User from '../domains/auth/user.model.js';
import Role from '../domains/auth/role.models.js'; // Fixed path (removed extra 's' if typo, based on your imports)
import Branch from '../domains/store/branch.model.js';
import InventoryItem from '../domains/inventory/item.model.js'; // Check path
import Customer from '../domains/customers/customer.model.js'; // Check path
import Invoice from '../domains/sales/invoice.model.js';

export const createTenantSchema = async (tenantData, adminUserData) => {
  const schemaName = tenantData.db_schema;
  
  // Validate Schema Name Security
  if (!/^[a-zA-Z0-9_]+$/.test(schemaName)) {
      throw new Error("Invalid schema name. Only alphanumeric and underscores allowed.");
  }

  const t = await sequelize.transaction();

  try {
    // 1. Create Schema
    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`, { transaction: t });
    
    // 2. Set Path to New Schema for Table Creation
    await sequelize.query(`SET search_path TO "${schemaName}"`, { transaction: t });

    // 3. Sync Tables (Order matters for Foreign Keys)
    // Note: In production, using migrations is better than sync(), but sync is okay for MVP.
    
    await Branch.sync({ transaction: t }); // Branch first (User depends on it)
    await Role.sync({ transaction: t });
    await User.sync({ transaction: t });
    await Customer.sync({ transaction: t });
    await InventoryItem.sync({ transaction: t });
    await Invoice.sync({ transaction: t });
    // await InvoiceItem.sync({ transaction: t }); // Uncomment when model exists
    // await InvoicePayment.sync({ transaction: t }); // Uncomment when model exists

    // 4. Seed Initial Data
    
    // Roles
    await Role.bulkCreate([
        {
            name: 'store_owner',
            permissions: ['ALL_ACCESS'],
            description: 'Full access to all system features'
        },
        {
            name: 'branch_manager',
            permissions: ['VIEW_DASHBOARD', 'MANAGE_INVENTORY', 'MANAGE_STAFF', 'CREATE_SALE'],
            description: 'Manages a specific branch'
        },
        {
            name: 'sales_man',
            permissions: ['CREATE_SALE', 'VIEW_INVENTORY', 'REGISTER_CUSTOMER'],
            description: 'Standard sales access'
        }
    ], { transaction: t });

    // Main Branch
    const mainBranch = await Branch.create({
      name: 'Main Branch',
      location: 'Headquarters',
      phone: tenantData.phone,
      is_main: true
    }, { transaction: t });

    // Admin User
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(adminUserData.password, salt);

    await User.create({
      full_name: adminUserData.full_name,
      username: adminUserData.username,
      password: hashedPassword,
      role: 'store_owner', // Must match the name in Role table
      branch_id: mainBranch.id,
      is_active: true
    }, { transaction: t });

    await t.commit();
    return true;

  } catch (error) {
    await t.rollback();
    logger.error('Schema creation error', { component: 'tenant-service', schema: schemaName, error: error?.message, stack: error?.stack });
    try {
        await sequelize.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE`);
    } catch (cleanupError) {
        logger.error('Schema cleanup after error failed', { component: 'tenant-service', error: cleanupError?.message });
    }
    throw error; 
  } finally {
    // Always reset path to public
    await sequelize.query(`SET search_path TO public`);
  }
};