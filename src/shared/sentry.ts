// Sentry for both the API and the worker. DSN from env; completely disabled when unset.
import * as Sentry from '@sentry/node';
import config from '../app/config';
import { getContext } from './requestContext';

let enabled = false;

export const initSentry = (service: 'api' | 'worker'): void => {
  if (!config.sentry_dsn) return;
  Sentry.init({
    dsn: config.sentry_dsn,
    environment: config.NODE_ENV,
    initialScope: { tags: { service } },
  });
  enabled = true;
};

export const isSentryEnabled = (): boolean => enabled;

export const captureException = (err: unknown, extra?: Record<string, unknown>): void => {
  if (!enabled) return;
  const ctx = getContext();
  Sentry.withScope((scope) => {
    if (ctx?.requestId) scope.setTag('requestId', ctx.requestId);
    if (ctx?.callId) scope.setTag('callId', ctx.callId);
    if (extra) scope.setExtras(extra);
    Sentry.captureException(err);
  });
};

export const flushSentry = async (timeoutMs = 2000): Promise<void> => {
  if (enabled) await Sentry.flush(timeoutMs);
};
