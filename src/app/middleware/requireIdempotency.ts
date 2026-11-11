import { createHash } from 'crypto';
import { NextFunction, Request, RequestHandler, Response } from 'express';
import httpStatus from 'http-status';
import AppError from '../error/AppError';
import catchAsync from '../utils/catchAsync';
import { logger } from '../../shared/logger';
import { IdempotencyKey } from '../modules/idempotencyKey/idempotencyKey.model';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
const MAX_KEY_LENGTH = 255;

// Stable serialisation: object keys sorted, so {a,b} and {b,a} hash the same.
const canonicalise = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = canonicalise((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
};

export const hashRequest = (endpoint: string, body: unknown): string =>
  createHash('sha256')
    .update(endpoint)
    .update('\n')
    .update(JSON.stringify(canonicalise(body ?? {})))
    .digest('hex');

const endpointOf = (req: Request): string =>
  `${req.method} ${req.baseUrl}${req.route?.path ?? req.path}`;

const subjectOf = (req: Request): string => {
  // The authenticated subject comes from the token, never from the body.
  const user = req.user as { userId?: string; _id?: string } | undefined;
  const id = user?.userId ?? user?._id;
  if (!id) {
    // Programming error: this middleware must sit after authentication.
    throw new AppError(
      httpStatus.INTERNAL_SERVER_ERROR,
      'requireIdempotency must run after authentication',
    );
  }
  return String(id);
};

/**
 * Per-route idempotency for money-creating POSTs. Sits between validation and the
 * controller.
 *
 *  - missing Idempotency-Key                -> 400
 *  - same key, DIFFERENT request hash       -> 409 (a client bug; replaying the old
 *                                              response would hide it)
 *  - same key, same hash, completed         -> stored status and body, service untouched
 *  - same key, same hash, still in flight   -> 409
 *  - first use                              -> handler runs; a 2xx response is stored
 *                                              before it is sent, any other outcome
 *                                              releases the key so the client can retry
 *
 * Applied in Phases 5, 6 and 7 only.
 */
export const requireIdempotency = (): RequestHandler =>
  catchAsync(async (req: Request, res: Response, next: NextFunction) => {
    const key = req.get(IDEMPOTENCY_HEADER);
    if (!key || !key.trim()) {
      throw new AppError(httpStatus.BAD_REQUEST, 'Idempotency-Key header is required');
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new AppError(httpStatus.BAD_REQUEST, 'Idempotency-Key header is too long');
    }

    const userId = subjectOf(req);
    const endpoint = endpointOf(req);
    const requestHash = hashRequest(endpoint, req.body);

    const replayOrReject = async (): Promise<boolean> => {
      const existing = await IdempotencyKey.findOne({ key, userId }).lean();
      if (!existing) return false;
      if (existing.requestHash !== requestHash) {
        throw new AppError(
          httpStatus.CONFLICT,
          'Idempotency-Key was already used with a different request',
        );
      }
      if (existing.statusCode === undefined || existing.statusCode === null) {
        throw new AppError(
          httpStatus.CONFLICT,
          'A request with this Idempotency-Key is still being processed',
        );
      }
      res.setHeader('Idempotent-Replayed', 'true');
      res.status(existing.statusCode).json(existing.responseBody);
      return true;
    };

    if (await replayOrReject()) return;

    try {
      await IdempotencyKey.create({ key, userId, endpoint, requestHash });
    } catch (err) {
      // A concurrent request with the same key won the race on the unique index.
      if ((err as { code?: number }).code === 11000) {
        if (await replayOrReject()) return;
        throw new AppError(
          httpStatus.CONFLICT,
          'A request with this Idempotency-Key is still being processed',
        );
      }
      throw err;
    }

    const originalJson = res.json.bind(res);
    res.json = ((body?: unknown) => {
      const status = res.statusCode;
      const settle =
        status >= 200 && status < 300
          ? IdempotencyKey.updateOne(
              { key, userId },
              {
                $set: {
                  statusCode: status,
                  responseBody: JSON.parse(JSON.stringify(body ?? null)),
                },
              },
            )
          : IdempotencyKey.deleteOne({ key, userId });

      settle
        .catch((err) => logger.error({ err, key, endpoint }, 'idempotency settle failed'))
        .finally(() => {
          originalJson(body);
        });
      return res;
    }) as Response['json'];

    next();
  });
