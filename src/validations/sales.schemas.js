import { z } from "zod";
import { normalizeToLatinDigits } from "../utils/normalizeNumbers.js";

const paymentMethod = z.enum([
  "Cash",
  "K-Net",
  "Visa/Master",
  "Link",
  "Cheque",
]);

const saleItem = z
  .object({
    id: z.coerce.number().int().positive("Item id is required."),
    meters: z
      .union([
        z.coerce.number().positive("Valid length in meters is required."),
        z.string(),
      ])
      .transform((v) =>
        typeof v === "string" ? parseFloat(normalizeToLatinDigits(v)) : v
      ),
    price_per_meter: z
      .union([z.coerce.number().min(0), z.string()])
      .transform((v) =>
        typeof v === "string" ? parseFloat(normalizeToLatinDigits(v)) : v
      ),
    discount: z
      .union([z.coerce.number().min(0), z.string()])
      .optional()
      .transform((v) =>
        v === undefined || v === null || v === ""
          ? 0
          : typeof v === "string"
            ? parseFloat(normalizeToLatinDigits(v)) || 0
            : v
      ),
    total_price: z
      .union([
        z.coerce.number().positive("Total price is required."),
        z.string(),
      ])
      .transform((v) =>
        typeof v === "string" ? parseFloat(normalizeToLatinDigits(v)) : v
      ),
    quantity: z
      .union([
        z.coerce.number().int().min(1, "Quantity must be at least 1."),
        z.string(),
      ])
      .optional()
      .transform((v) =>
        v === undefined || v === null || v === ""
          ? 1
          : Math.max(1, parseInt(normalizeToLatinDigits(String(v)), 10) || 1)
      ),
  })
  .strict();

const payment = z
  .object({
    method: paymentMethod,
    amount: z
      .union([z.coerce.number().min(0), z.string()])
      .transform((v) =>
        typeof v === "string" ? parseFloat(normalizeToLatinDigits(v)) : v
      ),
    reference_number: z.string().max(100).optional().nullable(),
    reference: z.string().max(100).optional().nullable(),
  })
  .strict()
  .transform((p) => {
    const { reference, ...rest } = p;
    return {
      ...rest,
      reference_number: p.reference_number ?? reference ?? null,
    };
  });

export const createSaleBody = z
  .object({
    customer_id: z.coerce.number().int().positive("Customer ID is required."),
    branch_id: z.coerce.number().int().positive().optional(),
    items: z.array(saleItem).min(1, "At least one item is required."),
    payments: z.array(payment).min(1, "At least one payment is required."),
    notes: z.string().max(2000).optional().nullable(),
  })
  .strict();
