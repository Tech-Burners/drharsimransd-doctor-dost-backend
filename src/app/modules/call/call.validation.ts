import { z } from 'zod';

const objectId = z.string().regex(/^[a-f0-9]{24}$/, { message: 'Invalid id' });

// The patient is NEVER in the body: it is the token subject. The rate, the balance and the
// duration are computed on the server.
const startBody = z.object({
  doctorId: objectId,
  isUrgent: z.boolean({ invalid_type_error: 'isUrgent must be true or false' }).optional(),
});

const idParams = z.object({ id: objectId });
const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

export const callBodies = { startBody, idParams, listQuery };

export const callValidation = {
  startSchema: z.object({ body: startBody }),
  idSchema: z.object({ params: idParams }),
  listSchema: z.object({ query: listQuery }),
};
