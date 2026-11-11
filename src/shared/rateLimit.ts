// Redis-backed counters for login, OTP and registration abuse limits.
//
// Only SET .. EX .. NX, INCR, TTL, GET and DEL are used. A counter is always created WITH
// its expiry (SET NX EX, then INCR), so a crash between two commands can never leave a
// counter that lives forever and locks someone out permanently.
//
// Fails CLOSED: if Redis is not configured or does not answer within REDIS_OP_TIMEOUT_MS
// the caller gets a 503. ioredis is configured with maxRetriesPerRequest: null (BullMQ
// requires it), so without the timeout a Redis outage would hang requests instead of
// failing them.
import httpStatus from 'http-status';
import AppError from '../app/error/AppError';
import config from '../app/config';
import { getRedis } from './redis';
import { logger } from './logger';

/** The subset of ioredis this module uses. A test double implements the same. */
export interface RateLimitStore {
  set(key: string, value: string | number, ...args: Array<string | number>): Promise<unknown>;
  incr(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
  del(...keys: string[]): Promise<number>;
}

const REDIS_OP_TIMEOUT_MS = 2000;

let storeOverride: RateLimitStore | null = null;

/** Tests inject a store. Pass null to restore the real Redis connection. */
export const setRateLimitStore = (store: RateLimitStore | null): void => {
  storeOverride = store;
};

const unavailable = () =>
  new AppError(httpStatus.SERVICE_UNAVAILABLE, 'Service temporarily unavailable. Please try again shortly.');

const run = async <T>(op: (store: RateLimitStore) => Promise<T>): Promise<T> => {
  const store = storeOverride ?? (config.redis_url ? (getRedis() as unknown as RateLimitStore) : null);
  if (!store) {
    logger.error('rate limiter unavailable: REDIS_URL is not set');
    throw unavailable();
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      op(store),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('redis timeout')), REDIS_OP_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    logger.error({ err }, 'rate limiter redis failure');
    throw unavailable();
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Run a command against the shared store with the same timeout and fail-closed behaviour. */
export const withStore = run;

export interface HitResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/** Count one event against key. Allowed while the count is within limit. */
export const hit = (key: string, limit: number, windowSeconds: number): Promise<HitResult> =>
  run(async (s) => {
    await s.set(key, 0, 'EX', windowSeconds, 'NX');
    const count = await s.incr(key);
    if (count <= limit) return { allowed: true, count, retryAfterSeconds: 0 };
    const ttl = await s.ttl(key);
    return { allowed: false, count, retryAfterSeconds: ttl > 0 ? ttl : windowSeconds };
  });

/** hit(), but throws 429 when the limit is exceeded. */
export const enforce = async (
  key: string,
  limit: number,
  windowSeconds: number,
  message = 'Too many requests. Please try again later.',
): Promise<void> => {
  const result = await hit(key, limit, windowSeconds);
  if (!result.allowed) throw new AppError(httpStatus.TOO_MANY_REQUESTS, message);
};

/** Take a cooldown slot. acquired=false means one is already running. */
export const cooldown = (
  key: string,
  seconds: number,
): Promise<{ acquired: boolean; retryAfterSeconds: number }> =>
  run(async (s) => {
    const res = await s.set(key, 1, 'EX', seconds, 'NX');
    if (res === 'OK') return { acquired: true, retryAfterSeconds: 0 };
    const ttl = await s.ttl(key);
    return { acquired: false, retryAfterSeconds: ttl > 0 ? ttl : seconds };
  });

/** Remaining lock time in seconds, or 0 when not locked. */
export const lockRemaining = (key: string): Promise<number> =>
  run(async (s) => {
    const v = await s.get(key);
    if (v === null) return 0;
    const ttl = await s.ttl(key);
    return ttl > 0 ? ttl : 0;
  });

export const lock = (key: string, seconds: number): Promise<unknown> =>
  run((s) => s.set(key, 1, 'EX', seconds));

export const clear = (...keys: string[]): Promise<number> => run((s) => s.del(...keys));
