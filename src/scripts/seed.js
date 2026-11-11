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

const FABRIC_TYPES = [
  "Cotton",
  "Silk",
  "Wool",
  "Linen",
  "Polyester",
  "Viscose",
  "Chiffon",
  "Crepe",
  "Satin",
  "Velvet",
  "Lace",
  "Denim",
];
const PATTERNS = [
  "Plain",
  "Floral",
  "Striped",
  "Checkered",
  "Polka Dot",
  "Geometric",
  "Embroidered",
  "Printed",
];
const COLORS = ["White", "Black", "Beige", "Red", "Blue", "Navy", "Green", "Grey"];
const BASE_COST = {
  Cotton: 2.5, Silk: 9.5, Wool: 7, Linen: 6, Polyester: 1.8, Viscose: 2.4,
  Chiffon: 2.2, Crepe: 2.8, Satin: 3.2, Velvet: 4.5, Lace: 6.5, Denim: 3,
};

const seedDatabase = async () => {
  try {
    await sequelize.authenticate();
    logger.info("Connected to DB, cleaning data", { component: "seed" });

    await sequelize.sync({ force: true });

    const passwordHash = await bcrypt.hash("123456", 10);

    const tenant = await Tenant.create({
      name: "KuwaitQumash Fabrics",
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

      for (const fabricType of FABRIC_TYPES) {
        for (let m = 0; m < 10; m++) {
          const pattern = faker.helpers.arrayElement(PATTERNS);
          const color = faker.helpers.arrayElement(COLORS);
          const lengthMeters = faker.number.float({
            min: 20,
            max: 120,
            precision: 0.01,
          });
          const cost = BASE_COST[fabricType] || 3;

          await InventoryItem.create({
            item_name: `${fabricType} ${pattern}`,
            fabric_type: fabricType,
            pattern,
            color,
            width_cm: faker.helpers.arrayElement([90, 110, 140, 150, 160]),
            unit: "meter",
            length_m: lengthMeters,
            quantity: faker.number.int({ min: 1, max: 5 }),
            cost_per_meter: (cost * 0.9).toFixed(3),
            price_per_meter: (cost * 1.4).toFixed(3),
            barcode: `${branchId}-${fabricType.substring(0, 2).toUpperCase()}-${faker.string.numeric(6)}`,
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
        let totalMeters = 0;

        for (let x = 0; x < itemCount; x++) {
          const w = faker.number.float({ min: 1, max: 12, precision: 0.01 });
          const fabricType = faker.helpers.arrayElement(FABRIC_TYPES);
          const pattern = faker.helpers.arrayElement(PATTERNS);
          const color = faker.helpers.arrayElement(COLORS);
          const p = parseFloat(((BASE_COST[fabricType] || 3) * 1.4).toFixed(3));
          const discount = faker.datatype.boolean(0.25)
            ? faker.number.float({ min: 0.5, max: 3, precision: 0.5 })
            : 0;
          const sub = parseFloat((w * p - discount).toFixed(3));

          const soldItem = await InventoryItem.create({
            item_name: `${fabricType} ${pattern}`,
            fabric_type: fabricType,
            pattern,
            color,
            unit: "meter",
            length_m: w,
            cost_per_meter: ((BASE_COST[fabricType] || 3) * 0.9).toFixed(3),
            price_per_meter: p.toFixed(3),
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
            fabric_type: fabricType,
            color,
            price_per_meter: p,
            discount,
            subtotal: sub,
          });

          totalAmount += sub;
          totalMeters += w;
        }

        const invoice = await Invoice.create({
          invoice_number: `INV-${branchId}-${Date.now()}-${n}`,
          customer_id: randomCustomer.id,
          total_meters: totalMeters,
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
            color: item.color,
            meters: item.meters,
            price_per_meter: item.price_per_meter,
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
