import { faker } from "@faker-js/faker";
import bcrypt from "bcrypt";
import sequelize from "../config/database.js";
import User from "../domains/auth/user.model.js";
import Branch from "../domains/store/branch.model.js";
import Customer from "../domains/customers/customer.model.js";
import InventoryItem from "../domains/inventory/item.model.js";
import Invoice from "../domains/sales/invoice.model.js";
import InvoiceItem from "../domains/sales/invoice-item.model.js";
import InvoicePayment from "../domains/sales/payment.model.js";
import Tenant from "../domains/platform/tenant.model.js";
import dotenv from "dotenv";
import logger from "../utils/logger.js";

dotenv.config();

const KARATS = ["18", "21", "22", "24"];
const CATEGORIES = [
  "Ring",
  "Necklace",
  "Bracelet",
  "Earring",
  "Set",
  "General",
];

const seedDatabase = async () => {
  try {
    await sequelize.authenticate();
    logger.info("Connected to DB, cleaning data", { component: "seed" });

    await sequelize.sync({ force: true });

    const passwordHash = await bcrypt.hash("123456", 10);

    const tenant = await Tenant.create({
      name: "Grace Jewelers",
      slug: "grace",
      db_schema: "public",
      owner_name: "Grace Owner",
      phone: "96550000000",
      subscription_status: "active",
    });
    console.log(`✅ Created Tenant: ${tenant.name}`);

    const branchesData = [
      {
        name: "KuwaitQumash Main Branch",
        location: "Salmiya",
        phone: "96550001111",
        is_main: true,
      },
      {
        name: "KuwaitQumash Avenues",
        location: "Avenues Mall",
        phone: "96550002222",
        is_main: false,
      },
      {
        name: "KuwaitQumash Al-Kout",
        location: "Fahaheel",
        phone: "96550003333",
        is_main: false,
      },
    ];

    const branches = [];

    for (let i = 0; i < branchesData.length; i++) {
      const branch = await Branch.create(branchesData[i]);
      branches.push(branch);

      const username = i === 0 ? "admin" : `manager${i + 1}`;
      const role = i === 0 ? "store_owner" : "branch_manager";

      const user = await User.create({
        username: username,
        password: passwordHash,
        full_name: i === 0 ? "Super Admin" : `Manager ${i + 1}`,
        role: role,
        branch_id: branch.id,
      });

      branch.manager_id = user.id;
      await branch.save();

      console.log(`✅ Branch: ${branch.name} | User: ${username}`);
    }

    for (const branch of branches) {
      const branchId = branch.id;
      const adminId = branch.manager_id;

      for (let j = 0; j < 5; j++) {
        await User.create({
          username: `staff_${branchId}_${j + 1}`,
          password: passwordHash,
          full_name: faker.person.fullName(),
          role: "sales_man",
          branch_id: branchId,
        });
      }

      const branchCustomers = [];
      for (let k = 0; k < 20; k++) {
        const cust = await Customer.create({
          full_name: faker.person.fullName(),
          phone: faker.phone.number("965########"),
          civil_id: faker.string.numeric(12),
          nationality: Math.random() > 0.8 ? "Expat" : "Kuwaiti",
          type: Math.random() > 0.9 ? "VIP" : "Regular",
          branch_id: branchId,
          created_by: adminId,
        });
        branchCustomers.push(cust);
      }

      for (const cat of CATEGORIES) {
        for (let m = 0; m < 10; m++) {
          const fabric_type = faker.helpers.arrayElement(KARATS);
          const meters = faker.number.float({
            min: 2,
            max: 50,
            precision: 0.01,
          });
          let basePrice = fabric_type === "24" ? 20 : fabric_type === "21" ? 17 : 14.5;

          await InventoryItem.create({
            item_name: `${cat} ${faker.commerce.productAdjective()}`,
            category: cat,
            fabric_type: fabric_type,
            meters: meters,
            cost_per_meter: (basePrice - 1).toFixed(3),
            barcode: `${branchId}-${cat.substring(0, 2).toUpperCase()}-${faker.string.numeric(6)}`,
            branch_id: branchId,
            created_by: adminId,
            status: "In Stock",
          });
        }
      }

      for (let n = 0; n < 50; n++) {
        const randomCustomer = faker.helpers.arrayElement(branchCustomers);
        const date = faker.date.recent({ days: 120 });

        const soldItems = [];
        const itemCount = faker.number.int({ min: 1, max: 4 });
        let totalAmount = 0;
        let totalWeight = 0;

        for (let x = 0; x < itemCount; x++) {
          const w = faker.number.float({ min: 3, max: 25, precision: 0.01 });
          const cat = faker.helpers.arrayElement(CATEGORIES);
          const k = faker.helpers.arrayElement(KARATS);
          const p = k === "24" ? 22 : k === "22" ? 19 : 17.5;
          const labor = faker.number.float({ min: 2, max: 8, precision: 0.5 });
          const sub = w * (p + labor);

          const soldItem = await InventoryItem.create({
            item_name: `${cat} ${faker.commerce.productAdjective()}`,
            category: cat,
            fabric_type: k,
            meters: w,
            cost_per_meter: (p - 1.5).toFixed(3),
            barcode: `SOLD-${branchId}-${n}-${x}-${faker.string.numeric(4)}`,
            branch_id: branchId,
            created_by: adminId,
            status: "Sold",
            createdAt: date,
            updatedAt: date,
          });

          soldItems.push({
            inventory_item_id: soldItem.id,
            item_name: soldItem.item_name,
            meters: w,
            fabric_type: k,
            price_per_gram: p,
            discount: labor,
            subtotal: sub,
          });

          totalAmount += sub;
          totalWeight += w;
        }

        const invoice = await Invoice.create({
          invoice_number: `INV-${branchId}-${Date.now()}-${n}`,
          customer_id: randomCustomer.id,
          total_meters: totalWeight,
          total_amount: totalAmount,
          branch_id: branchId,
          created_by: adminId,
          createdAt: date,
          updatedAt: date,
        });

        for (const item of soldItems) {
          await InvoiceItem.create({
            invoice_id: invoice.id,
            inventory_item_id: item.inventory_item_id,
            item_name: item.item_name,
            fabric_type: item.fabric_type,
            meters: item.meters,
            price_per_meter: item.price_per_gram,
            discount: item.discount,
            total_price: item.subtotal,
          });
        }

        const method = faker.helpers.arrayElement(["Cash", "K-Net", "Link"]);
        await InvoicePayment.create({
          invoice_id: invoice.id,
          method: method,
          amount: totalAmount,
          reference_number: method !== "Cash" ? faker.string.numeric(10) : null,
        });
      }
    }

    console.log("🎉 SEEDING COMPLETE!");
    process.exit(0);
  } catch (error) {
    logger.error("Seeding failed", {
      component: "seed",
      error: error?.message,
      stack: error?.stack,
    });
    process.exit(1);
  }
};

seedDatabase();
