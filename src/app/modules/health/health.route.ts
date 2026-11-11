import { Router } from 'express';
import { z } from 'zod';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { registerRoute } from '../../../shared/openapi';
import { getHealth, HealthChecks } from './health.service';

const healthResponse = z.object({
  status: z.enum(['ok', 'degraded']),
  mongo: z.enum(['up', 'down']),
  redis: z.enum(['up', 'down']),
  uptimeSeconds: z.number(),
});

registerRoute({
  method: 'get',
  path: '/health',
  summary: 'Mongo and Redis reachability',
  tags: ['system'],
  responses: {
    200: {
      description: 'Both dependencies reachable',
      content: { 'application/json': { schema: healthResponse } },
    },
    503: { description: 'A dependency is down' },
  },
});

export const createHealthRoutes = (checks?: HealthChecks): Router => {
  const router = Router();
  router.get(
    '/',
    catchAsync(async (_req, res) => {
      const report = await getHealth(checks);
      sendResponse(res, {
        statusCode: report.status === 'ok' ? 200 : 503,
        success: report.status === 'ok',
        message: report.status === 'ok' ? 'Healthy' : 'Degraded',
        data: report,
      });
    }),
  );
  return router;
};

export const healthRoutes = createHealthRoutes();
