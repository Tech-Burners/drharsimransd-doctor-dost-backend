import { z } from 'zod';

// The patient chooses the amount in WHOLE RUPEES (client decision). Fractions, paise and
// strings are rejected here; the server converts to paise and enforces the limits.
const createOrderBody = z.object({
  amountRupees: z
    .number({ required_error: 'amountRupees is required', invalid_type_error: 'amountRupees must be a number' })
    .int({ message: 'amountRupees must be a whole number of rupees' })
    .positive({ message: 'amountRupees must be positive' })
    .max(100_000_000, { message: 'amountRupees is too large' }),
});

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const walletBodies = { createOrderBody, listQuery };

export const walletValidation = {
  createOrderSchema: z.object({ body: createOrderBody }),
  listSchema: z.object({ query: listQuery }),
};
