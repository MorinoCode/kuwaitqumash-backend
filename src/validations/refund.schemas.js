import { z } from "zod";

const refundItemSchema = z.object({
  invoice_item_id: z.coerce.number().int().positive(),
  quantity_refunded: z.coerce.number().int().positive(),
  amount_refunded: z.coerce.number().min(0),
});

const refundPaymentSchema = z.object({
  method: z.enum(["Cash", "K-Net", "Visa/Master", "Link", "Cheque"]),
  amount: z.coerce.number().min(0),
  reference_number: z.string().max(100).optional().nullable(),
});

export const createRefundBody = z.object({
  invoice_id: z.coerce.number().int().positive(),
  items: z.array(refundItemSchema).min(1, "At least one item is required"),
  payments: z.array(refundPaymentSchema).min(1, "At least one payment method is required"),
  notes: z.string().max(1000).optional().nullable(),
});
