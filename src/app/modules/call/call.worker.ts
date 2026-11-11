// Worker-process registrations for calls (src/worker.ts calls this). Never imported by the API.
import { Worker } from 'bullmq';
import { createQueue, createWorker } from '../../../shared/queue';
import { logger } from '../../../shared/logger';
import { setCallId } from '../../../shared/requestContext';
import { callService } from './call.service';
import { CALL_QUEUES } from './call.jobs';
import { runCallSweep } from './call.sweep';

const SWEEP_EVERY_MS = 30_000;

export const startCallWorkers = async (): Promise<Worker[]> => {
  // The sweep: a fixed scheduler id, so several workers still produce one schedule.
  const sweepQueue = createQueue(CALL_QUEUES.SWEEP);
  await sweepQueue.upsertJobScheduler('call-sweep', { every: SWEEP_EVERY_MS }, { name: 'sweep', data: {} });

  const sweep = createWorker(
    CALL_QUEUES.SWEEP,
    async () => {
      const stats = await runCallSweep();
      if (stats.missed || stats.finalized || stats.cutOff || stats.closedNoEndEvent || stats.errors) {
        logger.info(stats, 'call sweep');
      }
    },
    1,
  );
  sweep.on('closed', () => void sweepQueue.close());

  // Both handlers re-read state and exit if it has moved, so a duplicate or late job is harmless.
  const ringing = createWorker(CALL_QUEUES.RINGING_TIMEOUT, async (job) => {
    setCallId(job.data.callId);
    await callService.markMissed(job.data.callId);
  });
  const finalize = createWorker(CALL_QUEUES.FINALIZE, async (job) => {
    setCallId(job.data.callId);
    await callService.finalize(job.data.callId);
  });

  return [sweep, ringing, finalize];
};
