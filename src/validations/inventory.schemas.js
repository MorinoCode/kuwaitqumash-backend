import { z } from 'zod';

const unitEnum = z.enum(['meter', 'roll']);

const addItemBase = {
  fabric_type: z.string().min(1, 'Fabric type is required.').max(100).trim(),
  item_name: z.string().max(255).trim().optional().nullable(),
  item_name_ar: z.string().max(255).trim().optional().nullable(),
  composition: z.string().max(150).trim().optional().nullable(),
  pattern: z.string().max(100).trim().optional().nullable(),
  color: z.string().max(100).trim().optional().nullable(),
  width_cm: z.coerce.number().min(0).optional().nullable(),
  unit: unitEnum.optional().default('meter'),
  length_m: z.coerce.number().min(0).optional().default(0),
  roll_length_m: z.coerce.number().min(0).optional().nullable(),
  quantity: z.coerce.number().int().min(0).optional().default(1),
  min_stock_level: z.coerce.number().min(0).optional().default(5),
  cost_per_meter: z.coerce.number().min(0).optional().default(0),
  price_per_meter: z.coerce.number().min(0, 'Valid price per meter is required.'),
  country_of_origin: z.string().max(100).trim().optional().nullable(),
  description: z.string().max(5000).trim().optional().nullable(),
  description_ar: z.string().max(5000).trim().optional().nullable(),
  barcode: z.string().max(100).trim().optional().nullable(),
  branch_id: z.coerce.number().int().positive().optional().nullable(),
};

export const addItemBody = z.object(addItemBase).strict();

const updateItemBase = {
  fabric_type: z.string().min(1).max(100).trim().optional(),
  item_name: z.string().max(255).trim().optional().nullable(),
  item_name_ar: z.string().max(255).trim().optional().nullable(),
  composition: z.string().max(150).trim().optional().nullable(),
  pattern: z.string().max(100).trim().optional().nullable(),
  color: z.string().max(100).trim().optional().nullable(),
  width_cm: z.coerce.number().min(0).optional().nullable(),
  unit: unitEnum.optional(),
  length_m: z.coerce.number().min(0).optional(),
  roll_length_m: z.coerce.number().min(0).optional().nullable(),
  quantity: z.coerce.number().int().min(0).optional(),
  min_stock_level: z.coerce.number().min(0).optional(),
  cost_per_meter: z.coerce.number().min(0).optional(),
  price_per_meter: z.coerce.number().min(0).optional(),
  country_of_origin: z.string().max(100).trim().optional().nullable(),
  description: z.string().max(5000).trim().optional().nullable(),
  description_ar: z.string().max(5000).trim().optional().nullable(),
  barcode: z.string().max(100).trim().optional().nullable(),
  status: z.enum(['In Stock', 'Sold', 'Reserved', 'Out of Stock']).optional(),
  branch_id: z.coerce.number().int().positive().optional().nullable(),
};

export const updateItemBody = z.object(updateItemBase).strict();
