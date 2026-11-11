import { Request, Response, Router } from 'express';
import httpStatus from 'http-status';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth';
import validateRequest from '../../middleware/validateRequest';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { USER_ROLE } from '../user/user.constants';
import { registerRoute } from '../../../shared/openapi';
import { refundService } from './refund.service';

// No amount: the refund is the charge the ledger recorded for the call.
const refundBody = z.object({
  callId: z.string({ required_error: 'callId is required' }).regex(/^[a-f0-9]{24}$/, { message: 'Invalid callId' }),
  reason: z.string({ required_error: 'reason is required' }).trim().min(3).max(200),
  note: z.string().trim().max(1000).optional(),
});

export const refundRoutes = Router();

refundRoutes.post(
  '/',
  authenticate,
  requireRole(USER_ROLE.ADMIN),
  validateRequest(z.object({ body: refundBody })),
  catchAsync(async (req: Request, res: Response) => {
    const data = await refundService.refundCall(
      { userId: req.user.userId },
      { callId: req.body.callId, reason: req.body.reason, note: req.body.note },
    );
    sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Refund recorded', data });
  }),
);

registerRoute({
  method: 'post',
  path: '/admin/refunds',
  tags: ['admin'],
  summary:
    'Admin only. Refund the charge recorded for a call. Appends a refund entry; the original charge is untouched. No amount is accepted',
  security: [{ bearerAuth: [] }],
  request: { body: { required: true, content: { 'application/json': { schema: refundBody } } } },
  responses: {
    201: { description: '{ refundEntryId, callId, amountPaise, balanceAfterPaise }' },
    403: { description: 'Not an admin' },
    404: { description: 'Call not found' },
    409: { description: 'No charge to refund, or already refunded' },
  },
});
