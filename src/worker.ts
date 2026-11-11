// Worker entrypoint: a SEPARATE process from the API. Everything scheduled or delayed
// (prescription reminder/expiry, sweeps, reconciliation, token cleanup) runs here and
// nowhere else. If a job were registered in the API process it would run once per API
// instance, i.e. twice as soon as there are two.
//
// Phase 3 provides the shell only. Each later phase adds its workers to `startWorkers`.
import 'dotenv/config';
import { Worker } from 'bullmq';
import mongoose from 'mongoose';
import { connectMongo } from './shared/db';
import { closeRedis, getRedis } from './shared/redis';
import { logger } from './shared/logger';
import { captureException, flushSentry, initSentry } from './shared/sentry';
import { randomUUID } from 'crypto';
import { runWithContext } from './shared/requestContext';
import { startOutboxWorker } from './app/modules/outbox/outbox.worker';

initSentry('worker');

const workers: Worker[] = [];

// Later phases register their queue workers here via createWorker() from shared/queue.
const startWorkers = async (): Promise<Worker[]> => [await startOutboxWorker()];

const shutdown = async (signal: string, code = 0) => {
  logger.info({ signal }, 'worker shutting down');
  await Promise.allSettled(workers.map((w) => w.close()));
  await closeRedis();
  await mongoose.disconnect().catch(() => undefined);
  await flushSentry();
  process.exit(code);
};

const main = async () => {
  await connectMongo();
  // ioredis connects lazily and retries forever, so getRedis() alone never fails. Ping
  // with a deadline so a bad REDIS_URL stops the worker instead of letting it idle
  // while reporting "started".
  await Promise.race([
    getRedis().ping(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Redis unreachable (no PONG within 10s)')), 10000),
    ),
  ]);
  workers.push(...(await startWorkers()));
  logger.info({ workers: workers.length }, 'worker started');
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (err) => {
  runWithContext({ requestId: randomUUID() }, () => {
    logger.error({ err }, 'Unhandled rejection in worker');
    captureException(err);
  });
  void flushSentry().then(() => process.exit(1));
});

main().catch((err) => {
  logger.error({ err }, 'worker failed to start');
  captureException(err);
  void flushSentry().then(() => process.exit(1));
});
