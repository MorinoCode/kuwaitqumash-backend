import { z } from "zod";

const kuwaitPhone = z
  .string()
  .trim()
  .min(6, "Phone number is required.")
  .max(20, "Phone number is too long.");

const optionalNullableDate = z
  .union([z.string().trim().min(1), z.null(), z.literal("")])
  .optional()
  .transform((val) => (val ? val : null));

export const adminLoginBody = z
  .object({
    email: z.string().trim().email("Valid admin email is required.").max(150),
    password: z.string().min(1, "Password is required.").max(200),
  })
  .strict();

export const createTenantBody = z
  .object({
    store_name: z
      .string()
      .trim()
      .min(2, "Store name must be at least 2 characters.")
      .max(100),
    owner_name: z.string().trim().min(2, "Owner name is required.").max(100),
    phone: kuwaitPhone,
    username: z
      .string()
      .trim()
      .min(2, "Username is required.")
      .max(100)
      .transform((s) => s.toLowerCase())
      .refine(
        (s) => /^[a-z0-9_.-]+$/.test(s),
        "Invalid username format.",
      ),
    password: z
      .string()
      .min(8, "Password must be at least 8 characters.")
      .max(200),
    subscription_status: z
      .enum(["active", "inactive", "suspended"])
      .optional(),
    subscription_expires_at: optionalNullableDate,
  })
  .strict();

export const updateTenantBody = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    owner_name: z.string().trim().min(2).max(100).optional(),
    phone: kuwaitPhone.optional(),
    subscription_status: z
      .enum(["active", "inactive", "suspended"])
      .optional(),
    subscription_expires_at: optionalNullableDate,
  })
  .strict();

export const adminBranchBody = z
  .object({
    name: z.string().trim().min(1, "Branch name is required.").max(100),
    location: z.string().trim().max(255).optional().nullable(),
    phone: z.string().trim().max(30).optional().nullable(),
  })
  .strict();

