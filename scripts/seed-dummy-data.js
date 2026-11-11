/**
 * Dummy Data Seeder Script
 * 
 * این اسکریپت dummy data کامل برای تست اپلیکیشن ایجاد می‌کند
 * Store ID, Username و Password برای login آماده می‌کند
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
import OldGold from '../src/domains/old-gold/old-gold.model.js';
import { generateUniqueBarcode } from '../src/utils/barcode.js';

// Constants
const KARATS = ['18', '21', '22', '24'];
const METAL_TYPES = ['Gold', 'Silver', 'Platinum', 'Diamond'];
const CATEGORIES = {
  Gold: ['Ring', 'Necklace', 'Bracelet', 'Earring', 'Chain', 'Set', 'Pendant', 'Bangle'],
  Silver: ['Ring', 'Necklace', 'Bracelet', 'Earring', 'Chain', 'Set'],
  Platinum: ['Ring', 'Necklace', 'Bracelet', 'Earring', 'Set'],
  Diamond: ['Ring', 'Necklace', 'Earring', 'Pendant', 'Bracelet']
};

const DIAMOND_CUTS = ['Round', 'Princess', 'Emerald', 'Asscher', 'Cushion', 'Oval', 'Pear', 'Marquise', 'Heart'];
const DIAMOND_COLORS = ['D', 'E', 'F', 'G', 'H', 'I', 'J', 'K'];
const DIAMOND_CLARITIES = ['FL', 'IF', 'VVS1', 'VVS2', 'VS1', 'VS2', 'SI1', 'SI2'];
const DIAMOND_SHAPES = ['Round', 'Princess', 'Emerald', 'Asscher', 'Cushion', 'Oval', 'Pear', 'Marquise', 'Heart'];
const DIAMOND_SETTINGS = ['Prong', 'Bezel', 'Channel', 'Pave', 'Tension'];

const STONE_TYPES = ['Diamond', 'Ruby', 'Sapphire', 'Emerald', 'Pearl', 'Topaz', 'Amethyst'];
const PAYMENT_METHODS = ['Cash', 'K-Net', 'Visa/Master', 'Link', 'Cheque'];
const CUSTOMER_TYPES = ['Regular', 'VIP', 'Wholesaler'];
const NATIONALITIES = ['Kuwaiti', 'Egyptian', 'Lebanese', 'Syrian', 'Indian', 'Pakistani', 'Filipino'];

// Helper functions
const generateRandomString = (length) => {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const generateBarcode = (metal, category, karat) => {
  const metalCode = metal === 'Gold' ? 'G' : (metal === 'Silver' ? 'S' : (metal === 'Platinum' ? 'P' : 'D'));
  const catCode = category ? category.substring(0, 3).toUpperCase() : 'GEN';
  const karatCode = (metal === 'Diamond' || !karat) ? '00' : karat.toString();
  const randomPart = generateRandomString(8);
  return `${metalCode}-${catCode}-${karatCode}-${randomPart}`;
};

const generateRFID = () => {
  return `RFID-${generateRandomString(12)}`;
};

const getBasePrice = (metal, karat) => {
  if (metal === 'Gold') {
    if (karat === '24') return 22.0;
    if (karat === '22') return 19.0;
    if (karat === '21') return 17.5;
    if (karat === '18') return 14.5;
  } else if (metal === 'Silver') {
    return 0.8;
  } else if (metal === 'Platinum') {
    return 35.0;
  }
  return 0;
};

const generateStones = (count = 0) => {
  if (count === 0) return [];
  const stones = [];
  for (let i = 0; i < count; i++) {
    stones.push({
      type: faker.helpers.arrayElement(STONE_TYPES),
      weight: parseFloat(faker.number.float({ min: 0.1, max: 2.0, precision: 0.01 }).toFixed(2)),
      hasValue: faker.datatype.boolean(),
      description: faker.lorem.sentence()
    });
  }
  return stones;
};

const generateArabicName = (englishName) => {
  const translations = {
    'Ring': 'خاتم',
    'Necklace': 'قلادة',
    'Bracelet': 'سوار',
    'Earring': 'أقراط',
    'Chain': 'سلسلة',
    'Set': 'طقم',
    'Pendant': 'قلادة',
    'Bangle': 'سوار'
  };
  const base = translations[englishName] || englishName;
  return `${base} ${faker.helpers.arrayElement(['ذهبي', 'فضي', 'ماسي', 'كلاسيكي'])}`;
};

async function seedDummyData() {
  try {
    logger.info('Starting dummy data seeding', { component: 'seed-dummy-data' });
    await sequelize.authenticate();
    logger.info('Database connection established', { component: 'seed-dummy-data' });

    const passwordHash = await bcrypt.hash('123456', 10);

    // Create 2-3 dummy tenants with clear Store IDs
    const tenantData = [
      {
        name: 'Royal Gold Store',
        owner_name: 'Ahmed Al-Sabah',
        phone: '96550001111',
        username: 'admin_royal',
        password: '123456'
      },
      {
        name: 'Diamond Palace',
        owner_name: 'Fatima Al-Kuwaiti',
        phone: '96550002222',
        username: 'admin_diamond',
        password: '123456'
      }
    ];

    logger.info('Creating tenants', { component: 'seed-dummy-data' });
    const loginCredentials = [];

    for (const tenantInfo of tenantData) {
      // Create tenant
      const sanitizedStoreName = tenantInfo.name.trim();
      const slug = sanitizedStoreName.toLowerCase().replace(/ /g, '-').replace(/[^\w-]+/g, '');
      const db_schema = `tenant_${slug.replace(/-/g, '_')}`;

      // Check if tenant already exists
      const existingTenant = await Tenant.findOne({ where: { slug } });
      if (existingTenant) {
        logger.warn('Tenant already exists, skipping', { component: 'seed-dummy-data', name: tenantInfo.name });
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

      // Create tenant schema
      await createTenantSchema(tenant, {
        full_name: tenantInfo.owner_name,
        username: tenantInfo.username,
        password: '123456' // Will be hashed inside createTenantSchema
      });

      logger.info('Created tenant', {
        component: 'seed-dummy-data',
        tenant: tenant.name,
        storeId: slug,
        username: tenantInfo.username,
        password: '123456'
      });

      // Store credentials for final summary
      loginCredentials.push({
        storeName: tenant.name,
        storeId: slug,
        username: tenantInfo.username,
        password: '123456'
      });

      const schema = db_schema;
      await sequelize.query(`SET search_path TO "${schema}", public`);

      // Get owner user
      const owner = await User.schema(schema).findOne({ where: { role: 'store_owner' } });
      if (!owner) {
        logger.error('Owner user not found', { component: 'seed-dummy-data', tenant: tenant.name });
        continue;
      }

      // Get main branch
      const mainBranch = await Branch.schema(schema).findOne({ where: { is_main: true } });
      if (!mainBranch) {
        logger.error('Main branch not found', { component: 'seed-dummy-data', tenant: tenant.name });
        continue;
      }

      // Create additional branches (2-3 branches per tenant)
      const branches = [mainBranch];
      const branchNames = ['Salmiya Branch', 'The Avenues Branch', 'Hawalli Branch'];
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
      logger.info('Created branches', { component: 'seed-dummy-data', count: branches.length });

      // Create users (1 manager per branch + 3-5 salesmen)
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

      // Create customers (30-50 per tenant)
      const customers = [];
      const customerCount = faker.number.int({ min: 30, max: 50 });
      for (let i = 0; i < customerCount; i++) {
        const gender = faker.helpers.arrayElement(['M', 'F']);
        const customer = await Customer.schema(schema).create({
          full_name: faker.person.fullName(),
          phone: faker.phone.number('965########'),
          civil_id: faker.string.numeric(12),
          nationality: faker.helpers.arrayElement(NATIONALITIES),
          gender: gender,
          address: faker.location.streetAddress(),
          birth_date: faker.date.birthdate({ min: 18, max: 80, mode: 'age' }).toISOString().split('T')[0],
          expiry_date: faker.date.future({ years: 5 }).toISOString().split('T')[0],
          type: faker.helpers.arrayElement(CUSTOMER_TYPES),
          id_card_front_url: `https://example.com/id/front_${i}.jpg`,
          id_card_back_url: `https://example.com/id/back_${i}.jpg`,
          notes: faker.datatype.boolean() ? faker.lorem.sentence() : null,
          branch_id: faker.helpers.arrayElement(branches).id,
          created_by: faker.helpers.arrayElement(users).id
        });
        customers.push(customer);
      }
      logger.info('Created customers', { component: 'seed-dummy-data', count: customers.length });

      // Create inventory items (100-150 per tenant)
      const inventoryItems = [];
      const itemCount = faker.number.int({ min: 100, max: 150 });
      
      for (let i = 0; i < itemCount; i++) {
        const metal = faker.helpers.arrayElement(METAL_TYPES);
        const category = faker.helpers.arrayElement(CATEGORIES[metal] || CATEGORIES.Gold);
        const karat = metal === 'Diamond' ? null : faker.helpers.arrayElement(KARATS);
        const weight = parseFloat(faker.number.float({ min: 1.0, max: 100.0, precision: 0.001 }).toFixed(3));
        const basePrice = getBasePrice(metal, karat);
        const buyPrice = parseFloat((basePrice - faker.number.float({ min: 0.5, max: 2.0, precision: 0.1 })).toFixed(3));

        const itemName = `${category} ${faker.commerce.productAdjective()}`;
        const itemNameAr = generateArabicName(category);

        // Generate barcode
        let barcode;
        try {
          barcode = await generateUniqueBarcode(
            InventoryItem.schema(schema),
            metal,
            category,
            karat
          );
        } catch (error) {
          void error;
          // Fallback if barcode generation fails
          barcode = generateBarcode(metal, category, karat);
        }

        const itemData = {
          rfid_tag: faker.datatype.boolean(0.3) ? generateRFID() : null,
          barcode: barcode,
          item_name: itemName,
          item_name_ar: itemNameAr,
          category: category,
          karat: karat,
          weight: weight,
          quantity: faker.number.int({ min: 1, max: 5 }),
          min_stock_level: faker.number.int({ min: 1, max: 3 }),
          buy_price_per_gram: buyPrice,
          supplier_name: faker.company.name(),
          status: 'In Stock', // All items should be In Stock for testing
          branch_id: faker.helpers.arrayElement(branches).id,
          images: [
            `https://example.com/inventory/item_${i}_1.jpg`,
            `https://example.com/inventory/item_${i}_2.jpg`
          ],
          description: faker.lorem.paragraph(),
          description_ar: faker.lorem.paragraph(),
          country_of_origin: faker.helpers.arrayElement(['Italy', 'Turkey', 'India', 'Kuwait', 'UAE']),
          metal_type: metal,
          created_by: faker.helpers.arrayElement(users).id
        };

        // Add diamond fields if metal is Diamond
        if (metal === 'Diamond') {
          itemData.diamond_carat = parseFloat(faker.number.float({ min: 0.5, max: 5.0, precision: 0.01 }).toFixed(2));
          itemData.diamond_cut = faker.helpers.arrayElement(DIAMOND_CUTS);
          itemData.diamond_color = faker.helpers.arrayElement(DIAMOND_COLORS);
          itemData.diamond_clarity = faker.helpers.arrayElement(DIAMOND_CLARITIES);
          itemData.diamond_shape = faker.helpers.arrayElement(DIAMOND_SHAPES);
          itemData.diamond_setting = faker.helpers.arrayElement(DIAMOND_SETTINGS);
        }

        // Add stones if it's Gold/Silver with stones
        if ((metal === 'Gold' || metal === 'Silver') && faker.datatype.boolean(0.4)) {
          const stoneCount = faker.number.int({ min: 1, max: 5 });
          itemData.stones = generateStones(stoneCount);
        }

        const item = await InventoryItem.schema(schema).create(itemData);
        inventoryItems.push(item);
      }
      logger.info('Created inventory items', { component: 'seed-dummy-data', count: inventoryItems.length });

      // Create invoices (40-60 per tenant)
      const invoices = [];
      const invoiceCount = faker.number.int({ min: 40, max: 60 });
      let availableItems = inventoryItems.filter(item => item.status === 'In Stock');

      for (let i = 0; i < invoiceCount && availableItems.length > 0; i++) {
        const customer = faker.helpers.arrayElement(customers);
        const salesUser = faker.helpers.arrayElement(users.filter(u => u.role !== 'store_owner'));
        const branch = faker.helpers.arrayElement(branches);
        const invoiceDate = faker.date.recent({ days: 90 });

        // Select 1-3 items for this invoice (but not more than available)
        const itemCount = Math.min(faker.number.int({ min: 1, max: 3 }), availableItems.length);
        if (itemCount === 0) break; // No more items available
        
        const selectedItems = faker.helpers.arrayElements(availableItems, itemCount);
        
        // Remove selected items from available list (by ID)
        const selectedItemIds = selectedItems.map(item => item.id);
        availableItems = availableItems.filter(item => !selectedItemIds.includes(item.id));

        let totalWeight = 0;
        let totalLaborCost = 0;
        let totalAmount = 0;
        const invoiceItems = [];

        for (const inventoryItem of selectedItems) {
          const itemWeight = parseFloat(inventoryItem.weight);
          const sellPricePerGram = parseFloat((parseFloat(inventoryItem.buy_price_per_gram) + faker.number.float({ min: 1.0, max: 3.0, precision: 0.1 })).toFixed(3));
          const laborCost = parseFloat(faker.number.float({ min: 2.0, max: 8.0, precision: 0.5 }).toFixed(3));
          const itemTotal = parseFloat((itemWeight * (sellPricePerGram + laborCost)).toFixed(3));

          totalWeight += itemWeight;
          totalLaborCost += itemWeight * laborCost;
          totalAmount += itemTotal;

          invoiceItems.push({
            inventory_item_id: inventoryItem.id,
            item_name: inventoryItem.item_name,
            item_name_ar: inventoryItem.item_name_ar,
            karat: inventoryItem.karat || 'N/A',
            weight: itemWeight,
            buy_price_snapshot: parseFloat(inventoryItem.buy_price_per_gram),
            sell_price_per_gram: sellPricePerGram,
            labor_cost: laborCost,
            total_price: itemTotal
          });

          // Mark item as sold
          await inventoryItem.update({ status: 'Sold' });
        }

        const invoiceNumber = `INV-${tenant.slug.toUpperCase()}-${String(i + 1).padStart(6, '0')}`;
        const invoice = await Invoice.schema(schema).create({
          invoice_number: invoiceNumber,
          customer_id: customer.id,
          total_weight: parseFloat(totalWeight.toFixed(3)),
          total_labor_cost: parseFloat(totalLaborCost.toFixed(3)),
          total_amount: parseFloat(totalAmount.toFixed(3)),
          status: 'Paid',
          notes: faker.datatype.boolean(0.3) ? faker.lorem.sentence() : null,
          pdf_path: `invoices/${invoiceNumber}.pdf`,
          branch_id: branch.id,
          created_by: salesUser.id,
          created_at: invoiceDate,
          updated_at: invoiceDate
        });

        // Create invoice items
        for (const invItem of invoiceItems) {
          await InvoiceItem.schema(schema).create({
            invoice_id: invoice.id,
            inventory_item_id: invItem.inventory_item_id,
            item_name: invItem.item_name,
            item_name_ar: invItem.item_name_ar,
            karat: invItem.karat,
            weight: invItem.weight,
            buy_price_snapshot: invItem.buy_price_snapshot,
            sell_price_per_gram: invItem.sell_price_per_gram,
            labor_cost: invItem.labor_cost,
            total_price: invItem.total_price
          });
        }

        // Create payment (sometimes split payment)
        const paymentMethod = faker.helpers.arrayElement(PAYMENT_METHODS);
        const isSplit = faker.datatype.boolean(0.2); // 20% chance of split payment

        if (isSplit) {
          // Split payment: Cash + K-Net
          const cashAmount = parseFloat((totalAmount * 0.6).toFixed(3));
          const knetAmount = parseFloat((totalAmount * 0.4).toFixed(3));

          await InvoicePayment.schema(schema).create({
            invoice_id: invoice.id,
            method: 'Cash',
            amount: cashAmount,
            reference_number: null
          });

          await InvoicePayment.schema(schema).create({
            invoice_id: invoice.id,
            method: 'K-Net',
            amount: knetAmount,
            reference_number: faker.string.numeric(10)
          });
        } else {
          await InvoicePayment.schema(schema).create({
            invoice_id: invoice.id,
            method: paymentMethod,
            amount: parseFloat(totalAmount.toFixed(3)),
            reference_number: paymentMethod !== 'Cash' ? faker.string.numeric(10) : null
          });
        }

        invoices.push(invoice);
      }
      logger.info('Created invoices with items and payments', { component: 'seed-dummy-data', count: invoices.length });

      // Create old gold purchases (10-20 per tenant)
      const oldGoldCount = faker.number.int({ min: 10, max: 20 });
      for (let i = 0; i < oldGoldCount; i++) {
        const customer = faker.helpers.arrayElement(customers);
        const purchaseUser = faker.helpers.arrayElement(users);
        const branch = faker.helpers.arrayElement(branches);
        const karat = faker.helpers.arrayElement(KARATS);
        const weight = parseFloat(faker.number.float({ min: 5.0, max: 50.0, precision: 0.001 }).toFixed(3));
        const pricePerGram = parseFloat((getBasePrice('Gold', karat) - faker.number.float({ min: 2.0, max: 4.0, precision: 0.1 })).toFixed(3));
        const totalAmount = parseFloat((weight * pricePerGram).toFixed(3));

        const purchaseNumber = `OLD-${tenant.slug.toUpperCase()}-${String(i + 1).padStart(6, '0')}`;
        await OldGold.schema(schema).create({
          purchase_number: purchaseNumber,
          customer_id: customer.id,
          description: `${karat}K Old Gold ${faker.helpers.arrayElement(['Ring', 'Necklace', 'Bracelet', 'Mixed'])}`,
          karat: karat,
          weight: weight,
          price_per_gram: pricePerGram,
          total_amount: totalAmount,
          image_url: `https://example.com/oldgold/purchase_${i}.jpg`,
          status: faker.helpers.arrayElement(['In Stock', 'Sent to Melting', 'Sold as Scrap']),
          branch_id: branch.id,
          created_by: purchaseUser.id
        });
      }
      logger.info('Created old gold purchases', { component: 'seed-dummy-data', count: oldGoldCount });

      // Create WhatsApp config
      await WhatsappConfig.create({
        tenant_slug: tenant.slug,
        is_enabled: faker.datatype.boolean(0.5),
        owner_phone: tenant.phone,
        manager_phone: faker.phone.number('965########'),
        session_status: faker.helpers.arrayElement(['DISCONNECTED', 'CONNECTED']),
        last_active: faker.date.recent({ days: 7 })
      });

      logger.info('Completed seeding for tenant', { component: 'seed-dummy-data', tenant: tenant.name });
    }

    logger.info('Dummy data seeding completed successfully', { component: 'seed-dummy-data' });
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
