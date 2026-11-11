import { Request, Response, Router } from 'express';
import httpStatus from 'http-status';
import { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth';
import validateRequest from '../../middleware/validateRequest';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { USER_ROLE } from '../user/user.constants';
import { registerRoute } from '../../../shared/openapi';
import { recoveryService } from './recovery.service';

const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
// No amount: a write-off always forgives exactly what is still outstanding.
const writeOffBody = z.object({ note: z.string({ required_error: 'note is required' }).trim().min(5).max(1000) });
const writeOffParams = z.object({ earningId: z.string().regex(/^[a-f0-9]{24}$/, { message: 'Invalid earning id' }) });

export const recoveryRoutes = Router();

recoveryRoutes
  .get(
    '/',
    authenticate,
    requireRole(USER_ROLE.ADMIN),
    validateRequest(z.object({ query: listQuery })),
    catchAsync(async (req: Request, res: Response) => {
      const { rows, meta } = await recoveryService.listOpen(Number(req.query.page) || 1, Number(req.query.limit) || 20);
      sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Open recoveries', data: rows, meta });
    }),
  )
  .post(
    '/:earningId/write-off',
    authenticate,
    requireRole(USER_ROLE.ADMIN),
    validateRequest(z.object({ params: writeOffParams, body: writeOffBody })),
    catchAsync(async (req: Request, res: Response) => {
      const data = await recoveryService.writeOff(
        { userId: req.user.userId },
        { earningId: req.params.earningId, note: req.body.note },
      );
      sendResponse(res, { statusCode: httpStatus.CREATED, success: true, message: 'Recovery written off', data });
    }),
  );

const bearer = [{ bearerAuth: [] }];
registerRoute({
  method: 'get',
  path: '/admin/recoveries',
  tags: ['admin'],
  summary: 'Admin only. Reversed earnings the doctor still owes (outstandingPaise > 0), oldest first',
  security: bearer,
  request: { query: listQuery },
  responses: { 200: { description: 'Earnings with outstandingPaise' }, 403: { description: 'Not an admin' } },
});
registerRoute({
  method: 'post',
  path: '/admin/recoveries/{earningId}/write-off',
  tags: ['admin'],
  summary:
    'Admin only. Write off what is still outstanding on one reversed earning, after the recovery period (PlatformSetting.recoveryPeriodDays). Recorded as an append-only adjustment; nothing is deleted',
  security: bearer,
  request: { params: writeOffParams, body: { required: true, content: { 'application/json': { schema: writeOffBody } } } },
  responses: {
    201: { description: '{ earningId, writtenOffPaise }' },
    403: { description: 'Not an admin' },
    404: { description: 'Earning not found' },
    409: { description: 'Nothing outstanding, period not configured or not over, or already written off' },
  },
});
