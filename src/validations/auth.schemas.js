import { z } from 'zod';

const username = z
  .string()
  .min(1, 'Username is required.')
  .max(100)
  .transform((s) => s.trim().toLowerCase())
  .refine((s) => /^[a-zA-Z0-9_.-]+$/.test(s), 'Invalid username format. Use only letters, numbers, dots, dashes, underscores.');

const password = z
  .string()
  .min(1, 'Password is required.')
  .max(200);

export const loginBody = z.object({
  username,
  password,
}).strict();

export const changePasswordBody = z.object({
  current_password: z.string().min(1, 'Current password is required.').max(200),
  new_password: z
    .string()
    .min(6, 'New password must be at least 6 characters.')
    .max(200),
}).strict();
