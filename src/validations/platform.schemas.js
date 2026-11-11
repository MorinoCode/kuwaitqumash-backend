import { z } from "zod";
import { normalizeToLatinDigits } from "../utils/normalizeNumbers.js";

const username = z
  .string()
  .min(1, "Username is required.")
  .max(50)
  .transform((s) => s.trim().toLowerCase())
  .refine(
    (s) => /^[a-zA-Z0-9_.-]+$/.test(s),
    "Invalid username format. Use only letters, numbers, dots, dashes, underscores."
  );

const phone = z
  .string()
  .min(1, "Phone is required.")
  .max(20)
  .transform((s) => normalizeToLatinDigits(s).replace(/[^0-9+]/g, ""))
  .refine(
    (s) => s.length >= 8 && s.length <= 20,
    "Invalid phone number format."
  );

const password = z
  .string()
  .min(6, "Password must be at least 6 characters.")
  .max(200);

export const registerBody = z
  .object({
    store_name: z
      .string()
      .min(1, "Store name is required.")
      .max(100)
      .transform((s) => s.trim()),
    owner_name: z
      .string()
      .min(1, "Owner name is required.")
      .max(100)
      .transform((s) => s.trim()),
    phone,
    username,
    password,
  })
  .strict();

export const whatsappBulkBody = z
  .object({
    segment: z.enum([
      "all",
      "high_value_6m",
      "inactive_6m",
      "last_30d",
      "last_90d",
      "vip_only",
    ]),
    branch_id: z.coerce.number().int().positive().optional(),
    message: z.string().min(1, "Message is required.").max(4000).trim(),
    delay_ms: z.coerce
      .number()
      .int()
      .min(500)
      .max(60_000)
      .optional()
      .default(3000),
  })
  .strict();
