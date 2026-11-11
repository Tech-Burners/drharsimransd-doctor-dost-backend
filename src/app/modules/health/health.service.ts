import { isMongoReachable } from '../../../shared/db';
import { isRedisReachable } from '../../../shared/redis';

export interface HealthChecks {
  mongo: () => Promise<boolean>;
  redis: () => Promise<boolean>;
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  mongo: 'up' | 'down';
  redis: 'up' | 'down';
  uptimeSeconds: number;
}

const withTimeout = (p: Promise<boolean>, ms: number): Promise<boolean> =>
  Promise.race([p, new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms))]);

const defaultChecks: HealthChecks = {
  mongo: isMongoReachable,
  redis: isRedisReachable,
};

/** Reports mongo and redis reachability. A dependency that hangs counts as down. */
export const getHealth = async (
  checks: HealthChecks = defaultChecks,
  timeoutMs = 2000,
): Promise<HealthReport> => {
  const [mongo, redis] = await Promise.all([
    withTimeout(checks.mongo().catch(() => false), timeoutMs),
    withTimeout(checks.redis().catch(() => false), timeoutMs),
  ]);
  return {
    status: mongo && redis ? 'ok' : 'degraded',
    mongo: mongo ? 'up' : 'down',
    redis: redis ? 'up' : 'down',
    uptimeSeconds: Math.round(process.uptime()),
  };
};
