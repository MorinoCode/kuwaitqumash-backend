import sequelize from '../config/database.js';
import bcrypt from 'bcrypt';
import logger from './logger.js';
import User from '../domains/auth/user.model.js';
import Role from '../domains/auth/role.model.js';
import Branch from '../domains/store/branch.model.js';
import InventoryItem from '../domains/inventory/item.model.js';
import Customer from '../domains/customers/customer.model.js';
import Invoice from '../domains/sales/invoice.model.js';

export const createTenantSchema = async (tenantData, adminUserData) => {
  const schemaName = tenantData.db_schema;

  if (!/^[a-zA-Z0-9_]+$/.test(schemaName)) {
      throw new Error("Invalid schema name. Only alphanumeric and underscores allowed.");
  }

  const t = await sequelize.transaction();

  try {

    await sequelize.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}"`, { transaction: t });

    await sequelize.query(`SET search_path TO "${schemaName}"`, { transaction: t });

    await Branch.sync({ transaction: t });
    await Role.sync({ transaction: t });
    await User.sync({ transaction: t });
    await Customer.sync({ transaction: t });
    await InventoryItem.sync({ transaction: t });
    await Invoice.sync({ transaction: t });

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

    const mainBranch = await Branch.create({
      name: 'Main Branch',
      location: 'Headquarters',
      phone: tenantData.phone,
      is_main: true
    }, { transaction: t });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(adminUserData.password, salt);

    await User.create({
      full_name: adminUserData.full_name,
      username: adminUserData.username,
      password: hashedPassword,
      role: 'store_owner',
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

    await sequelize.query(`SET search_path TO public`);
  }
};
