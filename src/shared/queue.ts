// BullMQ queue factory. Queues are created here; Workers are created ONLY by the worker
// process (src/worker.ts). Nothing scheduled is ever registered in the API process, because
// it would then run once per API instance.
import { randomUUID } from 'crypto';
import { Job, JobsOptions, Processor, Queue, Worker } from 'bullmq';
import { createRedisConnection } from './redis';
import { logger } from './logger';
import { captureException } from './sentry';
import { getContext, runWithContext } from './requestContext';

/** Correlation ids carried inside job data so worker logs match the API request. */
export interface JobContext {
  requestId?: string;
  callId?: string;
}

export const JOB_CONTEXT_KEY = '_ctx';

export const createQueue = (name: string): Queue =>
  new Queue(name, {
    connection: createRedisConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: { age: 24 * 3600, count: 1000 },
      removeOnFail: { age: 7 * 24 * 3600 },
    },
  });

/** Adds the current requestId / callId to the job data. */
export const withJobContext = <T extends object>(data: T): T & { [JOB_CONTEXT_KEY]: JobContext } => {
  const ctx = getContext();
  return {
    ...data,
    [JOB_CONTEXT_KEY]: { requestId: ctx?.requestId, callId: ctx?.callId },
  };
};

/**
 * Enqueue a job with correlation ids attached. For delayed per-call jobs pass
 * opts.jobId = the call id so enqueuing twice is a no-op.
 */
export const enqueue = <T extends object>(
  queue: Queue,
  jobName: string,
  data: T,
  opts?: JobsOptions,
) => queue.add(jobName, withJobContext(data), opts);

/**
 * Create a Worker whose handler runs inside the job's correlation context, with failed
 * jobs logged and sent to Sentry. A failed job is otherwise invisible.
 */
export const createWorker = (
  name: string,
  processor: Processor,
  concurrency = 5,
): Worker => {
  const worker = new Worker(
    name,
    (job: Job) => {
      const ctx = (job.data?.[JOB_CONTEXT_KEY] ?? {}) as JobContext;
      return runWithContext(
        { requestId: ctx.requestId ?? randomUUID(), callId: ctx.callId },
        () => processor(job),
      );
    },
    { connection: createRedisConnection(), concurrency },
  );

  worker.on('failed', (job, err) => {
    const ctx = (job?.data?.[JOB_CONTEXT_KEY] ?? {}) as JobContext;
    runWithContext({ requestId: ctx.requestId ?? randomUUID(), callId: ctx.callId }, () => {
      logger.error(
        { err, queue: name, jobId: job?.id, jobName: job?.name, attemptsMade: job?.attemptsMade },
        'job failed',
      );
      captureException(err, { queue: name, jobId: job?.id, jobName: job?.name });
    });
  });
  worker.on('error', (err) => {
    logger.error({ err, queue: name }, 'worker error');
    captureException(err, { queue: name });
  });

  return worker;
};
