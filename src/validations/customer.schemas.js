import { z } from 'zod';

const customerType = z.enum(['Regular', 'VIP', 'Wholesaler']);
const gender = z.enum(['M', 'F']);

export const createCustomerBody = z.object({
  full_name: z.string().min(1, 'Full name is required.').max(255).trim(),
  phone: z.string().min(1, 'Phone is required.').max(50).trim(),
  address: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  branch_id: z.coerce.number().int().positive().optional().nullable(),
  gender: gender.optional(),
  type: customerType.optional(),
}).strict();

export const updateCustomerBody = z.object({
  full_name: z.string().min(1).max(255).trim().optional(),
  phone: z.string().min(1).max(50).trim().optional(),
  address: z.string().max(500).optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
  branch_id: z.coerce.number().int().positive().optional().nullable(),
  gender: gender.optional(),
  type: customerType.optional(),
}).strict();
