import pino from 'pino';
import config from '../app/config';
import { getContext } from './requestContext';

// Secrets never reach a log line.
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-razorpay-signature"]',
  'req.headers["agora-signature"]',
  'req.headers["agora-signature-v2"]',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.oldPassword',
  '*.token',
  '*.accessToken',
  '*.refreshToken',
  '*.otp',
  '*.pan',
  '*.bankAccountNumber',
  '*.secret',
  '*.apiKey',
  'password',
  'token',
  'otp',
];

export const logger = pino({
  level: process.env.LOG_LEVEL || (config.NODE_ENV === 'production' ? 'info' : 'debug'),
  base: { service: process.env.SERVICE_NAME || 'doctordost-api' },
  redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
  // requestId and callId on every line, without passing a logger around.
  mixin() {
    const ctx = getContext();
    return ctx ? { requestId: ctx.requestId, ...(ctx.callId && { callId: ctx.callId }) } : {};
  },
  ...(config.NODE_ENV === 'development' && process.env.LOG_PRETTY === 'true'
    ? { transport: { target: 'pino-pretty' } }
    : {}),
});
