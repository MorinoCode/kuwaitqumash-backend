/**
 * Dummy Data Seeder Script (KuwaitQumash - fabric platform)
 *
 * این اسکریپت داده‌ی نمونه‌ی کامل برای تست اپلیکیشن پارچه ایجاد می‌کند:
 * انبار متری، فروش متری، فاکتور، پرداخت و تنظیمات واتساپ.
 *
 * استفاده: node scripts/seed-dummy-data.js
 */

import { faker } from '@faker-js/faker';
import bcrypt from 'bcrypt';
import sequelize from '../src/config/database.js';
import Tenant from '../src/domains/platform/tenant.model.js';
import WhatsappConfig from '../src/domains/platform/whatsapp.config.model.js';
import { createTenantSchema } from '../src/utils/schema.manager.js';
import logger from '../src/utils/logger.js';
import dotenv from 'dotenv';

dotenv.config();

// Import models
import User from '../src/domains/auth/user.model.js';
import Branch from '../src/domains/store/branch.model.js';
import Customer from '../src/domains/customers/customer.model.js';
import InventoryItem from '../src/domains/inventory/item.model.js';
import Invoice from '../src/domains/sales/invoice.model.js';
import InvoiceItem from '../src/domains/sales/invoice-item.model.js';
import InvoicePayment from '../src/domains/sales/payment.model.js';
import { generateUniqueBarcode } from '../src/utils/barcode.js';

// Fabric vocabulary
const FABRIC_TYPES = [
  'Cotton',
  'Silk',
  'Wool',
  'Linen',
  'Polyester',
  'Viscose',
  'Chiffon',
  'Crepe',
  'Satin',
  'Velvet',
  'Lace',
  'Denim',
  'Jersey',
  'Organza',
  'Tulle',
  'Kashmir'
];

const PATTERNS = [
  'Plain',
  'Floral',
  'Striped',
  'Checkered',
  'Polka Dot',
  'Geometric',
  'Embroidered',
  'Printed',
  'Jacquard',
  'Paisley'
];

const COMPOSITIONS = [
  '100% Cotton',
  '100% Silk',
  '100% Wool',
  '100% Polyester',
  '50% Cotton 50% Polyester',
  '70% Polyester 30% Viscose',
  '95% Cotton 5% Elastane'
];

const COLORS = [
  'White',
  'Black',
  'Beige',
  'Cream',
  'Red',
  'Maroon',
  'Blue',
  'Navy',
  'Green',
  'Olive',
  'Yellow',
  'Pink',
  'Purple',
  'Brown',
  'Grey',
  'Multi'
];

const WIDTHS_CM = [90, 110, 140, 150, 160, 280];
const UNITS = ['meter', 'roll'];
const ORIGINS = ['Italy', 'Turkey', 'India', 'Kuwait', 'UAE', 'China', 'Korea'];
const PAYMENT_METHODS = ['Cash', 'K-Net', 'Visa/Master', 'Link', 'Cheque'];
const CUSTOMER_TYPES = ['Regular', 'VIP', 'Wholesaler'];
const NATIONALITIES = [
  'Kuwaiti',
  'Egyptian',
  'Lebanese',
  'Syrian',
  'Indian',
  'Pakistani',
  'Filipino'
];

// Purchase cost per meter (KD) per fabric type
const BASE_COST_PER_METER = {
  Cotton: 2.5,
  Silk: 9.5,
  Wool: 7.0,
  Linen: 6.0,
  Polyester: 1.8,
  Viscose: 2.4,
  Chiffon: 2.2,
  Crepe: 2.8,
  Satin: 3.2,
  Velvet: 4.5,
  Lace: 6.5,
  Denim: 3.0,
  Jersey: 2.6,
  Organza: 3.5,
  Tulle: 2.0,
  Kashmir: 12.0
};

const FABRIC_AR = {
  Cotton: 'قطن',
  Silk: 'حرير',
  Wool: 'صوف',
  Linen: 'كتان',
  Polyester: 'بوليستر',
  Viscose: 'فيسكوز',
  Chiffon: 'شيفون',
  Crepe: 'كريب',
  Satin: 'ساتان',
  Velvet: 'مخمل',
  Lace: 'دانتيل',
  Denim: 'جينز',
  Jersey: 'جيرسي',
  Organza: 'أورجانزا',
  Tulle: 'تول',
  Kashmir: 'كشمير'
};

const PATTERN_AR = {
  Plain: 'سادة',
  Floral: 'زهري',
  Striped: 'مخطط',
  Checkered: 'كاروهات',
  'Polka Dot': 'منقط',
  Geometric: 'هندسي',
  Embroidered: 'مطرز',
  Printed: 'مطبوع',
  Jacquard: 'جاكار',
  Paisley: 'بيسلي'
};

const round3 = (value) => parseFloat(Number(value).toFixed(3));

const generateRFID = () => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < 12; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return `RFID-${result}`;
};

async function seedDummyData() {
  try {
    logger.info('Starting dummy data seeding', {
      component: 'seed-dummy-data'
    });
    await sequelize.authenticate();
    logger.info('Database connection established', {
      component: 'seed-dummy-data'
    });

    const passwordHash = await bcrypt.hash('123456', 10);

    const tenantData = [
      {
        name: 'KuwaitQumash Fabrics',
        owner_name: 'Ahmed Al-Sabah',
        phone: '96550001111',
        username: 'admin_qumash',
        password: '123456'
      },
      {
        name: 'Qumash Textiles',
        owner_name: 'Fatima Al-Kuwaiti',
        phone: '96550002222',
        username: 'admin_textiles',
        password: '123456'
      }
    ];

    logger.info('Creating tenants', { component: 'seed-dummy-data' });
    const loginCredentials = [];

    for (const tenantInfo of tenantData) {
      const sanitizedStoreName = tenantInfo.name.trim();
      const slug = sanitizedStoreName
        .toLowerCase()
        .replace(/ /g, '-')
        .replace(/[^\w-]+/g, '');
      const db_schema = `tenant_${slug.replace(/-/g, '_')}`;

      const existingTenant = await Tenant.findOne({ where: { slug } });
      if (existingTenant) {
        logger.warn('Tenant already exists, skipping', {
          component: 'seed-dummy-data',
          name: tenantInfo.name
        });
        continue;
      }

      const tenant = await Tenant.create({
        name: sanitizedStoreName,
        slug,
        db_schema,
        owner_name: tenantInfo.owner_name,
        phone: tenantInfo.phone,
        subscription_status: 'active'
      });

      await createTenantSchema(tenant, {
        full_name: tenantInfo.owner_name,
        username: tenantInfo.username,
        password: '123456' // hashed inside createTenantSchema
      });

      logger.info('Created tenant', {
        component: 'seed-dummy-data',
        tenant: tenant.name,
        storeId: slug,
        username: tenantInfo.username,
        password: '123456'
      });

      loginCredentials.push({
        storeName: tenant.name,
        storeId: slug,
        username: tenantInfo.username,
        password: '123456'
      });

      const schema = db_schema;
      await sequelize.query(`SET search_path TO "${schema}", public`);

      const owner = await User.schema(schema).findOne({
        where: { role: 'store_owner' }
      });
      if (!owner) {
        logger.error('Owner user not found', {
          component: 'seed-dummy-data',
          tenant: tenant.name
        });
        continue;
      }

      const mainBranch = await Branch.schema(schema).findOne({
        where: { is_main: true }
      });
      if (!mainBranch) {
        logger.error('Main branch not found', {
          component: 'seed-dummy-data',
          tenant: tenant.name
        });
        continue;
      }

      // Branches
      const branches = [mainBranch];
      const branchNames = [
        'Salmiya Branch',
        'The Avenues Branch',
        'Hawalli Branch'
      ];
      for (let i = 0; i < 2; i++) {
        const branch = await Branch.schema(schema).create({
          name: branchNames[i] || `Branch ${i + 1}`,
          location: faker.location.streetAddress(),
          phone: faker.phone.number('965########'),
          is_main: false,
          manager_id: null
        });
        branches.push(branch);
      }
      logger.info('Created branches', {
        component: 'seed-dummy-data',
        count: branches.length
      });

      // Users
      const users = [owner];
      for (const branch of branches) {
        if (!branch.is_main) {
          const manager = await User.schema(schema).create({
            username: `manager_${branch.id}`,
            password: passwordHash,
            full_name: faker.person.fullName(),
            role: 'branch_manager',
            branch_id: branch.id,
            is_active: true
          });
          users.push(manager);
          branch.manager_id = manager.id;
          await branch.save();
        }
      }

      for (let i = 0; i < 4; i++) {
        const salesman = await User.schema(schema).create({
          username: `salesman_${i + 1}`,
          password: passwordHash,
          full_name: faker.person.fullName(),
          role: 'sales_man',
          branch_id: faker.helpers.arrayElement(branches).id,
          is_active: true
        });
        users.push(salesman);
      }
      logger.info('Created users', {
        component: 'seed-dummy-data',
        count: users.length,
        managers: branches.length - 1
      });

      // Customers
      const customers = [];
      const customerCount = faker.number.int({ min: 30, max: 50 });
      for (let i = 0; i < customerCount; i++) {
        const gender = faker.helpers.arrayElement(['M', 'F']);
        const customer = await Customer.schema(schema).create({
          full_name: faker.person.fullName(),
          phone: faker.phone.number('965########'),
          civil_id: faker.string.numeric(12),
          nationality: faker.helpers.arrayElement(NATIONALITIES),
          gender,
          address: faker.location.streetAddress(),
          birth_date: faker.date
            .birthdate({ min: 18, max: 80, mode: 'age' })
            .toISOString()
            .split('T')[0],
          expiry_date: faker.date
            .future({ years: 5 })
            .toISOString()
            .split('T')[0],
          type: faker.helpers.arrayElement(CUSTOMER_TYPES),
          id_card_front_url: `https://example.com/id/front_${i}.jpg`,
          id_card_back_url: `https://example.com/id/back_${i}.jpg`,
          notes: faker.datatype.boolean() ? faker.lorem.sentence() : null,
          branch_id: faker.helpers.arrayElement(branches).id,
          created_by: faker.helpers.arrayElement(users).id
        });
        customers.push(customer);
      }
      logger.info('Created customers', {
        component: 'seed-dummy-data',
        count: customers.length
      });

      // Inventory (fabric rolls / bolts, stock in meters)
      const inventoryItems = [];
      const itemCount = faker.number.int({ min: 100, max: 150 });

      for (let i = 0; i < itemCount; i++) {
        const fabricType = faker.helpers.arrayElement(FABRIC_TYPES);
        const pattern = faker.helpers.arrayElement(PATTERNS);
        const color = faker.helpers.arrayElement(COLORS);
        const unit = faker.helpers.arrayElement(UNITS);

        const baseCost = BASE_COST_PER_METER[fabricType] || 3.0;
        const costPerMeter = round3(
          baseCost * faker.number.float({ min: 0.85, max: 1.05, precision: 0.001 })
        );
        const pricePerMeter = round3(
          costPerMeter *
            faker.number.float({ min: 1.25, max: 1.7, precision: 0.001 })
        );

        const lengthMeters = round3(
          faker.number.float({ min: 20, max: 120, precision: 0.001 })
        );

        let barcode;
        try {
          barcode = await generateUniqueBarcode(
            InventoryItem.schema(schema),
            fabricType,
            pattern,
            null
          );
        } catch (error) {
          logger.warn('Barcode generation failed, using fallback', {
            component: 'seed-dummy-data',
            error: error?.message
          });
          barcode = `F-${String(i + 1).padStart(6, '0')}-${faker.string.alphanumeric(6).toUpperCase()}`;
        }

        const itemData = {
          rfid_tag: faker.datatype.boolean(0.3) ? generateRFID() : null,
          barcode,
          item_name: `${fabricType} ${pattern}`,
          item_name_ar: `${FABRIC_AR[fabricType]} ${PATTERN_AR[pattern]}`,
          fabric_type: fabricType,
          composition: faker.helpers.arrayElement(COMPOSITIONS),
          pattern,
          color,
          width_cm: faker.helpers.arrayElement(WIDTHS_CM),
          unit,
          length_m: lengthMeters,
          roll_length_m:
            unit === 'roll'
              ? round3(
                  faker.number.float({ min: 10, max: 50, precision: 0.001 })
                )
              : null,
          quantity: faker.number.int({ min: 1, max: 6 }),
          min_stock_level: faker.number.int({ min: 5, max: 20 }),
          cost_per_meter: costPerMeter,
          price_per_meter: pricePerMeter,
          supplier_name: faker.company.name(),
          status: 'In Stock',
          branch_id: faker.helpers.arrayElement(branches).id,
          images: [
            `https://example.com/inventory/item_${i}_1.jpg`,
            `https://example.com/inventory/item_${i}_2.jpg`
          ],
          description: faker.lorem.paragraph(),
          description_ar: faker.lorem.paragraph(),
          country_of_origin: faker.helpers.arrayElement(ORIGINS),
          created_by: faker.helpers.arrayElement(users).id
        };

        const item = await InventoryItem.schema(schema).create(itemData);
        inventoryItems.push(item);
      }
      logger.info('Created inventory items', {
        component: 'seed-dummy-data',
        count: inventoryItems.length
      });

      // Invoices (fabric sold by the meter)
      const invoices = [];
      const invoiceCount = faker.number.int({ min: 40, max: 60 });
      let availableItems = inventoryItems.filter(
        (item) => item.status === 'In Stock'
      );

      for (let i = 0; i < invoiceCount && availableItems.length > 0; i++) {
        const customer = faker.helpers.arrayElement(customers);
        const salesUser = faker.helpers.arrayElement(
          users.filter((u) => u.role !== 'store_owner')
        );
        const branch = faker.helpers.arrayElement(branches);
        const invoiceDate = faker.date.recent({ days: 90 });

        const lineCount = Math.min(
          faker.number.int({ min: 1, max: 3 }),
          availableItems.length
        );
        if (lineCount === 0) break;

        const selectedItems = faker.helpers.arrayElements(
          availableItems,
          lineCount
        );

        let totalMeters = 0;
        let totalDiscount = 0;
        let totalAmount = 0;
        const invoiceLines = [];

        for (const inventoryItem of selectedItems) {
          const stockMeters = parseFloat(inventoryItem.length_m) || 0;
          if (stockMeters <= 0) continue;

          const meters = round3(
            Math.min(
              stockMeters,
              faker.number.float({ min: 0.5, max: 12, precision: 0.001 })
            )
          );
          if (meters <= 0) continue;

          const pricePerMeter =
            parseFloat(inventoryItem.price_per_meter) ||
            round3(parseFloat(inventoryItem.cost_per_meter) * 1.4);
          const discount = faker.datatype.boolean(0.25)
            ? round3(
                faker.number.float({ min: 0.5, max: 5, precision: 0.001 })
              )
            : 0;
          const lineTotal = round3(meters * pricePerMeter - discount);

          totalMeters += meters;
          totalDiscount += discount;
          totalAmount += lineTotal;

          invoiceLines.push({
            inventory_item_id: inventoryItem.id,
            item_name: inventoryItem.item_name,
            item_name_ar: inventoryItem.item_name_ar,
            fabric_type: inventoryItem.fabric_type,
            color: inventoryItem.color,
            unit: inventoryItem.unit || 'meter',
            quantity: 1,
            meters,
            cost_per_meter_snapshot:
              parseFloat(inventoryItem.cost_per_meter) || 0,
            price_per_meter: pricePerMeter,
            discount,
            total_price: lineTotal
          });

          const remaining = round3(stockMeters - meters);
          await inventoryItem.update({
            length_m: remaining < 0 ? 0 : remaining,
            status: remaining <= 0 ? 'Sold' : 'In Stock'
          });
        }

        if (invoiceLines.length === 0) continue;

        const invoiceNumber = `INV-${tenant.slug.toUpperCase()}-${String(
          i + 1
        ).padStart(6, '0')}`;
        const invoice = await Invoice.schema(schema).create({
          invoice_number: invoiceNumber,
          customer_id: customer.id,
          total_meters: round3(totalMeters),
          total_discount: round3(totalDiscount),
          total_amount: round3(totalAmount),
          status: 'Paid',
          notes: faker.datatype.boolean(0.3) ? faker.lorem.sentence() : null,
          pdf_path: `invoices/${invoiceNumber}.pdf`,
          branch_id: branch.id,
          created_by: salesUser.id,
          created_at: invoiceDate,
          updated_at: invoiceDate
        });

        for (const line of invoiceLines) {
          await InvoiceItem.schema(schema).create({
            invoice_id: invoice.id,
            ...line
          });
        }

        const paymentMethod = faker.helpers.arrayElement(PAYMENT_METHODS);
        const isSplit = faker.datatype.boolean(0.2);

        if (isSplit) {
          await InvoicePayment.schema(schema).create({
            invoice_id: invoice.id,
            method: 'Cash',
            amount: round3(totalAmount * 0.6),
            reference_number: null
          });

          await InvoicePayment.schema(schema).create({
            invoice_id: invoice.id,
            method: 'K-Net',
            amount: round3(totalAmount * 0.4),
            reference_number: faker.string.numeric(10)
          });
        } else {
          await InvoicePayment.schema(schema).create({
            invoice_id: invoice.id,
            method: paymentMethod,
            amount: round3(totalAmount),
            reference_number:
              paymentMethod !== 'Cash' ? faker.string.numeric(10) : null
          });
        }

        invoices.push(invoice);
        availableItems = availableItems.filter(
          (item) =>
            !invoiceLines.some((line) => line.inventory_item_id === item.id)
        );
      }
      logger.info('Created invoices with items and payments', {
        component: 'seed-dummy-data',
        count: invoices.length
      });

      // WhatsApp config
      await WhatsappConfig.create({
        tenant_slug: tenant.slug,
        is_enabled: faker.datatype.boolean(0.5),
        owner_phone: tenant.phone,
        manager_phone: faker.phone.number('965########'),
        session_status: faker.helpers.arrayElement([
          'DISCONNECTED',
          'CONNECTED'
        ]),
        last_active: faker.date.recent({ days: 7 })
      });

      logger.info('Completed seeding for tenant', {
        component: 'seed-dummy-data',
        tenant: tenant.name
      });
    }

    logger.info('Dummy data seeding completed successfully', {
      component: 'seed-dummy-data'
    });
    loginCredentials.forEach((cred, index) => {
      logger.info('Login credential', {
        component: 'seed-dummy-data',
        index: index + 1,
        storeName: cred.storeName,
        storeId: cred.storeId,
        username: cred.username,
        password: cred.password
      });
    });
  } catch (error) {
    logger.error('Error seeding dummy data', {
      component: 'seed-dummy-data',
      error: error?.message,
      stack: error?.stack
    });
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

// Run the seed
seedDummyData();
