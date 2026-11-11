// REAL Redis + real BullMQ + real Mongo: the outbox drain actually runs from the scheduler.
// Skipped unless TEST_REDIS_URL is set (see docs/TESTING.md). Flushes that Redis database.
import IORedis from 'ioredis';
import mongoose from 'mongoose';
import { useTestDb } from '../../../test/helpers/db';
import config from '../../config';
import { closeRedis } from '../../../shared/redis';
import { OutboxEvent } from './outbox.model';
import { Notification } from '../notification/notification.model';
import { startOutboxWorker } from './outbox.worker';

const url = process.env.TEST_REDIS_URL;
const d = url ? describe : describe.skip;

d('outbox worker on real BullMQ', () => {
  useTestDb();
  const original = config.redis_url;

  beforeAll(async () => {
    const r = new IORedis(url as string);
    await r.flushdb();
    await r.quit();
    config.redis_url = url;
  });
  afterAll(async () => {
    config.redis_url = original;
    await closeRedis();
  });

  it('delivers a queued refund notice within a scheduler tick, once, and survives a second worker', async () => {
    const userId = new mongoose.Types.ObjectId();
    await OutboxEvent.create({
      type: 'refund.patient_notice',
      dedupeKey: 'call:real-bullmq:refund:patient',
      payload: { userId: String(userId), callId: 'c1', amountPaise: 1000, status: 'completed', reference: 'call:c1:refund', refundEntryId: 'e1' },
    });

    const w1 = await startOutboxWorker();
    const w2 = await startOutboxWorker(); // same scheduler id: still one schedule, no double delivery
    try {
      const deadline = Date.now() + 30_000;
      let done = false;
      while (Date.now() < deadline && !done) {
        await new Promise((r) => setTimeout(r, 500));
        done = (await OutboxEvent.countDocuments({ status: 'done' })) === 1;
      }
      expect(done).toBe(true);
      expect(await Notification.countDocuments({ userId })).toBe(1);
    } finally {
      await w1.close();
      await w2.close();
    }
  }, 60_000);
});
