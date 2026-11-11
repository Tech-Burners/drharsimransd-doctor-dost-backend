import IORedis, { Redis } from 'ioredis';
import config from '../app/config';
import { logger } from './logger';

let client: Redis | null = null;

// BullMQ requires maxRetriesPerRequest: null on its connections.
export const createRedisConnection = (): Redis => {
  if (!config.redis_url) throw new Error('REDIS_URL is not set');
  const connection = new IORedis(config.redis_url, {
    password: config.redis_password || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
  // Without a listener ioredis prints every connection error to the console.
  connection.on('error', (err) => logger.error({ err }, 'redis connection error'));
  return connection;
};

/** Shared connection for the process (presence keys, rate limits, health). */
export const getRedis = (): Redis => {
  if (!client) client = createRedisConnection();
  return client;
};

export const isRedisReachable = async (): Promise<boolean> => {
  try {
    if (!config.redis_url) return false;
    return (await getRedis().ping()) === 'PONG';
  } catch {
    return false;
  }
};

export const closeRedis = async (): Promise<void> => {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
};
