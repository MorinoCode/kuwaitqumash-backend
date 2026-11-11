import { z } from 'zod';

const username = z
  .string()
  .min(1, 'Username is required.')
  .max(50)
  .regex(/^[a-zA-Z0-9_.-]+$/, 'Invalid username format.');

const password = z.string().min(1, 'Password is required.').max(200);
const role = z.enum(['store_owner', 'branch_manager', 'sales_man']);

export const createBranchBody = z.object({
  name: z.string().min(1, 'Branch name is required.').max(100).trim(),
  location: z.string().max(255).trim().optional().default(''),
  phone: z.string().max(30).trim().optional().default(''),
}).strict();

export const updateBranchBody = z.object({
  name: z.string().min(1).max(100).trim().optional(),
  location: z.string().max(255).trim().optional(),
  phone: z.string().max(30).trim().optional(),
  whatsapp_invoice_enabled: z.union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? undefined : (v === true || v === 'true'))),
  whatsapp_invoice_to_store_enabled: z.union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? undefined : (v === true || v === 'true'))),
  whatsapp_invoice_to_store_phone: z.string().max(30).trim().optional().nullable(),
}).strict();

export const createStaffBody = z.object({
  full_name: z.string().min(1, 'Full name is required.').max(100).trim(),
  username,
  password,
  role,
  branch_id: z.coerce.number().int().positive('Branch is required.'),
}).strict();

export const updateStaffBody = z.object({
  full_name: z.string().min(1).max(100).trim().optional(),
  username: z.string().min(1).max(50).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  password: z.string().min(1).max(200).optional(),
  role: role.optional(),
  branch_id: z.coerce.number().int().positive().optional(),
  is_active: z.union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined ? undefined : (v === true || v === 'true'))),
}).strict();
