import { Router } from 'express';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth';
import validateRequest from '../../middleware/validateRequest';
import { requireIdempotency } from '../../middleware/requireIdempotency';
import { USER_ROLE } from '../user/user.constants';
import { registerRoute } from '../../../shared/openapi';
import { walletBodies, walletValidation } from './wallet.validation';
import { walletControllers } from './wallet.controller';

export const walletRoutes = Router();

// authenticate -> requireRole -> validation -> idempotency -> controller.
// Ownership: the service only ever reads and writes the token subject's own wallet.
walletRoutes
  .get('/', authenticate, requireRole(USER_ROLE.PATIENT), validateRequest(walletValidation.listSchema), walletControllers.getWallet)
  .post(
    '/orders',
    authenticate,
    requireRole(USER_ROLE.PATIENT),
    validateRequest(walletValidation.createOrderSchema),
    requireIdempotency(),
    walletControllers.createOrder,
  );

const bearer = [{ bearerAuth: [] }];

registerRoute({
  method: 'get',
  path: '/wallet',
  tags: ['wallet'],
  summary: 'Patient only. Ledger-derived balance (integer paise), the top-up packs, and a page of ledger entries',
  security: bearer,
  request: { query: walletBodies.listQuery },
  responses: {
    200: { description: '{ balancePaise, topupPacks, ledger[] } with pagination in meta' },
    401: { description: 'Not authenticated' },
    403: { description: 'Not a patient' },
  },
});

registerRoute({
  method: 'post',
  path: '/wallet/orders',
  tags: ['wallet'],
  summary:
    'Patient only. Create a Razorpay order for a top-up pack. Requires an Idempotency-Key header. The amount is looked up on the server',
  security: bearer,
  request: {
    headers: z.object({ 'Idempotency-Key': z.string().min(1).max(255) }),
    body: { required: true, content: { 'application/json': { schema: walletBodies.createOrderBody } } },
  },
  responses: {
    201: { description: '{ paymentOrderId, razorpayOrderId, amountPaise, currency, razorpayKeyId }' },
    400: { description: 'Unknown pack, or missing Idempotency-Key' },
    409: { description: 'Idempotency-Key reused with a different body, or still in flight' },
    502: { description: 'Payment provider failed' },
    503: { description: 'Top-ups not configured' },
  },
});
