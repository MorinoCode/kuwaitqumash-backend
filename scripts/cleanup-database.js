import sequelize from '../src/config/database.js';
import Tenant from '../src/domains/platform/tenant.model.js';
import WhatsappConfig from '../src/domains/platform/whatsapp.config.model.js';
import logger from '../src/utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

async function cleanupDatabase() {
  try {
    logger.info('Connecting to database', { component: 'cleanup-database' });
    await sequelize.authenticate();
    logger.info('Database connection established', { component: 'cleanup-database' });

    const tenants = await Tenant.findAll();
    logger.info('Fetched tenants', { component: 'cleanup-database', count: tenants.length });

    if (tenants.length === 0) {
      logger.info('No tenants found, nothing to clean', { component: 'cleanup-database' });
      process.exit(0);
    }

    logger.warn('Deleting ALL tenant data', {
      component: 'cleanup-database',
      tenants: tenants.map((t) => t.name)
    });

    for (const tenant of tenants) {
      const schemaName = tenant.db_schema;
      try {
        await sequelize.query(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
        logger.info('Schema deleted', { component: 'cleanup-database', schema: schemaName, tenant: tenant.name });
      } catch (error) {
        logger.error('Error deleting schema', {
          component: 'cleanup-database',
          schema: schemaName,
          error: error?.message
        });
      }
    }

    await Tenant.destroy({ where: {}, force: true });
    logger.info('Tenants deleted from public.tenants', { component: 'cleanup-database' });

    await WhatsappConfig.destroy({ where: {}, force: true });
    logger.info('WhatsApp configs deleted', { component: 'cleanup-database' });

    logger.info('Database cleanup completed. Run "npm run db:seed" to populate with dummy data.', {
      component: 'cleanup-database'
    });
  } catch (error) {
    logger.error('Error during cleanup', {
      component: 'cleanup-database',
      error: error?.message,
      stack: error?.stack
    });
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

cleanupDatabase();
