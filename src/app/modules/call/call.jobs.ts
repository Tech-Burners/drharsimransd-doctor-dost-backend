// Delayed jobs for calls. Producers live here; the WORKER registers the consumers
// (call.worker.ts). Nothing scheduled is ever registered in the API process.
//
// Every producer is best effort: if Redis is unreachable the failure is logged and the 30 second
// sweep (call.sweep.ts) catches the call. BullMQ custom job ids cannot contain ':'.
import { Queue } from 'bullmq';
import { createQueue, enqueue } from '../../../shared/queue';
import { logger } from '../../../shared/logger';

export const CALL_QUEUES = {
  RINGING_TIMEOUT: 'call-ringing-timeout',
  FINALIZE: 'call-finalize',
  SWEEP: 'call-sweep',
  // Consumed in Phase 7. Phase 6 only enqueues them, after a paid call ends.
  PRESCRIPTION_REMINDER: 'prescription-reminder',
  PRESCRIPTION_EXPIRY: 'prescription-expiry',
} as const;

export const RING_TIMEOUT_SECONDS = 30;
/** Short wait after a leave event so a quick rejoin is not mistaken for the end of the call. */
export const FINALIZE_DELAY_MS = 3000;
export const WARNING_SECONDS_BEFORE_CUTOFF = 60;

export interface CallJobs {
  /** After RING_TIMEOUT_SECONDS: if still ringing, move to missed. Job id = call id. */
  scheduleRingingTimeout(callId: string): Promise<void>;
  /** Try to end the call from its Agora events. `key` makes each trigger a distinct job. */
  scheduleFinalize(callId: string, key: string, delayMs?: number): Promise<void>;
  /** The 1 hour reminder and 2 hour expiry. Job id = call id on each queue, so enqueuing twice is a no-op. */
  schedulePrescriptionJobs(callId: string, reminderDelayMs: number, expiryDelayMs: number): Promise<void>;
}

const queues = new Map<string, Queue>();
const queueOf = (name: string): Queue => {
  let q = queues.get(name);
  if (!q) {
    q = createQueue(name);
    queues.set(name, q);
  }
  return q;
};

const bullJobs: CallJobs = {
  async scheduleRingingTimeout(callId) {
    await enqueue(queueOf(CALL_QUEUES.RINGING_TIMEOUT), 'ringing-timeout', { callId }, { delay: RING_TIMEOUT_SECONDS * 1000, jobId: callId });
  },
  async scheduleFinalize(callId, key, delayMs = FINALIZE_DELAY_MS) {
    await enqueue(queueOf(CALL_QUEUES.FINALIZE), 'finalize', { callId }, { delay: delayMs, jobId: `finalize-${callId}-${key}` });
  },
  async schedulePrescriptionJobs(callId, reminderDelayMs, expiryDelayMs) {
    await enqueue(queueOf(CALL_QUEUES.PRESCRIPTION_REMINDER), 'reminder', { callId }, { delay: reminderDelayMs, jobId: callId });
    await enqueue(queueOf(CALL_QUEUES.PRESCRIPTION_EXPIRY), 'expiry', { callId }, { delay: expiryDelayMs, jobId: callId });
  },
};

let jobs: CallJobs = bullJobs;
/** Tests inject their own. Pass null to restore BullMQ. */
export const setCallJobs = (j: CallJobs | null): void => {
  jobs = j ?? bullJobs;
};

/** Run a producer; never throw into the caller. Returns whether it was queued. */
export const tryJob = async (what: string, fn: (j: CallJobs) => Promise<void>): Promise<boolean> => {
  try {
    await fn(jobs);
    return true;
  } catch (err) {
    logger.error({ err, what }, 'could not queue a call job; the sweep will cover it');
    return false;
  }
};

export const closeCallQueues = async (): Promise<void> => {
  await Promise.allSettled([...queues.values()].map((q) => q.close()));
  queues.clear();
};
