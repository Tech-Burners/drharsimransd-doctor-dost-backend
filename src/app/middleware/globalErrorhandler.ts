/* eslint-disable @typescript-eslint/no-explicit-any */
import { ErrorRequestHandler } from 'express';
import { ZodError } from 'zod';
import { MulterError } from 'multer';
import config from '../config';
import { TErrorSources } from '../interface/error';
import handleZodError from '../error/ZodError';
import handleValidationError from '../error/ValidationError';
import handleDuplicateError from '../error/DuplicateError';
import handleCastError from '../error/CastError';
import AppError from '../error/AppError';
import handelMulterError from '../error/MulterError';
import { toEnvelope } from '../utils/sendResponse';
import { logger } from '../../shared/logger';
import { errorLineLogger } from '../utils/logger';
import { captureException } from '../../shared/sentry';

// One global error handler, one response envelope: { success, message, data, meta }.
// Error detail lives in meta (errorSources, requestId); the raw error object is never
// serialised to the client.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const globalErrorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  let statusCode = 500;
  let message = 'Something went wrong!';
  let errorSources: TErrorSources = [{ path: '', message: 'Something went wrong' }];

  const apply = (s: { statusCode: number; message: string; errorSources: TErrorSources }) => {
    statusCode = s.statusCode;
    message = s.message;
    errorSources = s.errorSources;
  };

  if (err instanceof ZodError) {
    apply(handleZodError(err));
  } else if (err?.name === 'ValidationError') {
    apply(handleValidationError(err));
  } else if (err?.name === 'CastError') {
    apply(handleCastError(err));
  } else if (err?.code === 11000) {
    apply(handleDuplicateError(err));
  } else if (err instanceof AppError) {
    statusCode = err.statusCode;
    message = err.message;
    errorSources = [{ path: '', message: err.message }];
  } else if (err instanceof MulterError) {
    apply(handelMulterError(err));
  } else if (err instanceof Error) {
    message = err.message;
    errorSources = [{ path: '', message: err.message }];
  }

  const logFields = {
    err,
    method: req.method,
    url: req.originalUrl,
    status: statusCode,
  };
  if (statusCode >= 500) {
    logger.error(logFields, message);
    captureException(err, { method: req.method, url: req.originalUrl });
  } else {
    logger.warn({ ...logFields, err: { message: err?.message, name: err?.name } }, message);
  }

  // Keep feeding logs/app.log (JSONL): the server home page's error table reads it.
  errorLineLogger.error({
    timestamp: new Date().toISOString(),
    level: 'error',
    message,
    stack: err?.stack,
    method: req.method,
    url: req.originalUrl,
    status: statusCode,
    ip: req.ip,
    userAgent: req.get('User-Agent') || '',
    requestId: req.id,
  });

  // Never leak internals of an unexpected error in production.
  if (statusCode >= 500 && config.NODE_ENV === 'production') {
    message = 'Something went wrong!';
    errorSources = [{ path: '', message }];
  }

  res.status(statusCode).json(
    toEnvelope({
      success: false,
      message,
      data: null,
      meta: {
        requestId: req.id,
        errorSources,
        stack: config.NODE_ENV === 'development' ? err?.stack : undefined,
      },
    }),
  );
};

export default globalErrorHandler;
