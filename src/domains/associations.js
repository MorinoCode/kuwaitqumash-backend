import Branch from "./store/branch.model.js";
import User from "./auth/user.model.js";
import Customer from "./customers/customer.model.js";
import InventoryItem from "./inventory/item.model.js";
import CustomInventoryOption from "./inventory/custom-option.model.js";
import Invoice from "./sales/invoice.model.js";
import InvoiceItem from "./sales/invoice-item.model.js";
import InvoicePayment from "./sales/payment.model.js";
import Refund from "./sales/refund.model.js";
import RefundItem from "./sales/refund-item.model.js";
import RefundPayment from "./sales/refund-payment.model.js";

let associationsApplied = false;

/**
 * Registers all multi-tenant model associations idempotently.
 * This ensures that express routes, background workers (dashboard-worker),
 * and CLI migration scripts share the identical Sequelize association graph.
 */
export const applyAssociations = () => {
  if (associationsApplied) return;
  associationsApplied = true;

  // Branch <-> User
  User.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
  Branch.hasMany(User, { foreignKey: "branch_id" });

  // Customer <-> Invoice
  Invoice.belongsTo(Customer, { foreignKey: "customer_id", as: "customer" });
  Customer.hasMany(Invoice, { foreignKey: "customer_id" });

  // User <-> Invoice
  Invoice.belongsTo(User, { foreignKey: "created_by", as: "creator" });
  User.hasMany(Invoice, { foreignKey: "created_by" });

  // Branch <-> Invoice
  Invoice.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
  Branch.hasMany(Invoice, { foreignKey: "branch_id" });

  // Invoice <-> InvoiceItem
  Invoice.hasMany(InvoiceItem, { foreignKey: "invoice_id", as: "items" });
  InvoiceItem.belongsTo(Invoice, { foreignKey: "invoice_id" });

  // Invoice <-> InvoicePayment
  Invoice.hasMany(InvoicePayment, { foreignKey: "invoice_id", as: "payments" });
  InvoicePayment.belongsTo(Invoice, { foreignKey: "invoice_id" });

  // Invoice <-> Refund
  Invoice.hasMany(Refund, { foreignKey: "invoice_id", as: "refunds" });
  Refund.belongsTo(Invoice, { foreignKey: "invoice_id", as: "invoice" });

  // Branch / User <-> Refund
  Refund.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
  Branch.hasMany(Refund, { foreignKey: "branch_id" });
  Refund.belongsTo(User, { foreignKey: "created_by", as: "creator" });
  User.hasMany(Refund, { foreignKey: "created_by" });

  // Refund <-> RefundItem
  Refund.hasMany(RefundItem, { foreignKey: "refund_id", as: "items" });
  RefundItem.belongsTo(Refund, { foreignKey: "refund_id" });
  RefundItem.belongsTo(InvoiceItem, {
    foreignKey: "invoice_item_id",
    as: "invoice_item",
  });
  RefundItem.belongsTo(InventoryItem, {
    foreignKey: "inventory_item_id",
    as: "inventory_item",
  });

  // Refund <-> RefundPayment
  Refund.hasMany(RefundPayment, { foreignKey: "refund_id", as: "payments" });
  RefundPayment.belongsTo(Refund, { foreignKey: "refund_id" });

  // Branch <-> InventoryItem
  InventoryItem.belongsTo(Branch, { foreignKey: "branch_id", as: "branch" });
  Branch.hasMany(InventoryItem, { foreignKey: "branch_id" });

  // InventoryItem <-> InvoiceItem
  InvoiceItem.belongsTo(InventoryItem, {
    foreignKey: "inventory_item_id",
    as: "inventory_item",
  });
  InventoryItem.hasMany(InvoiceItem, {
    foreignKey: "inventory_item_id",
    as: "InvoiceItems",
  });
};

// Automatically apply when module is loaded
applyAssociations();

export {
  Branch,
  User,
  Customer,
  InventoryItem,
  CustomInventoryOption,
  Invoice,
  InvoiceItem,
  InvoicePayment,
  Refund,
  RefundItem,
  RefundPayment,
};

