// Registers the outbox drain in the WORKER process only (src/worker.ts calls this). The
// scheduler id is fixed, so starting several workers still produces one schedule, and a
// lost Redis job self-heals on the next tick.
import { Worker } from 'bullmq';
import { createQueue, createWorker } from '../../../shared/queue';
import { logger } from '../../../shared/logger';
import { outboxHandlers } from './outbox.handlers';
import { outboxService } from './outbox.service';

export const OUTBOX_QUEUE = 'outbox';
const SCHEDULER_ID = 'outbox-drain';
const EVERY_MS = 10_000;

export const startOutboxWorker = async (): Promise<Worker> => {
  const queue = createQueue(OUTBOX_QUEUE);
  await queue.upsertJobScheduler(SCHEDULER_ID, { every: EVERY_MS }, { name: 'drain', data: {} });

  const worker = createWorker(
    OUTBOX_QUEUE,
    async () => {
      const stats = await outboxService.drain(outboxHandlers, { limit: 50 });
      if (stats.delivered || stats.retried || stats.failed) logger.info(stats, 'outbox drained');
    },
    1,
  );
  // The producer connection belongs to this worker; release it when the worker closes.
  worker.on('closed', () => void queue.close());
  return worker;
};
