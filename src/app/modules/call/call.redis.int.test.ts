// REAL Redis + real BullMQ + real MongoDB. Skipped unless TEST_REDIS_URL is set (docs/TESTING.md).
// Flushes that Redis database. Covers what a FakeRedis cannot: a key really expiring, the
// cooldown under real concurrency, and the worker's sweep and finalize running from BullMQ.
import IORedis from 'ioredis';
import mongoose from 'mongoose';
import { useTestDb } from '../../../test/helpers/db';
import config from '../../config';
import { closeRedis } from '../../../shared/redis';
import { setRateLimitStore } from '../../../shared/rateLimit';
import { setCallJobs, tryJob, closeCallQueues } from './call.jobs';
import { Doubles, installDoubles, makeDoctor, makePatient, makeSettings, NOON_IST, removeDoubles, talk } from '../../../test/helpers/callFixtures';
import { presenceService, presenceKey } from '../presence/presence.service';
import { callService } from './call.service';
import { startCallWorkers } from './call.worker';
import { Call } from './call.model';
import { WalletLedger } from '../wallet/walletLedger.model';

const url = process.env.TEST_REDIS_URL;
const d = url ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => Promise<boolean>, ms = 25_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(400);
  }
  return false;
};

d('calls against real Redis and BullMQ', () => {
  useTestDb();
  let doubles: Doubles;
  const original = { redis: config.redis_url, ttl: config.presence_ttl_seconds };

  beforeAll(async () => {
    const r = new IORedis(url as string);
    await r.flushdb();
    await r.quit();
    config.redis_url = url;
  });
  beforeEach(() => {
    doubles = installDoubles();
    setRateLimitStore(null); // use the real shared Redis connection
    setCallJobs(null); // real BullMQ producers
  });
  afterAll(async () => {
    config.redis_url = original.redis;
    config.presence_ttl_seconds = original.ttl;
    removeDoubles();
    await closeCallQueues();
    await closeRedis();
  });

  it('presence: the key REALLY expires, and a heartbeat renews it', async () => {
    config.presence_ttl_seconds = 2;
    const { doctor } = await makeDoctor({ online: false });
    const id = String(doctor._id);
    await presenceService.heartbeat(id);
    expect(await presenceService.isOnline(id)).toBe(true);
    const r = new IORedis(url as string);
    expect(await r.ttl(presenceKey(id))).toBeGreaterThan(0);
    await sleep(1200);
    await presenceService.heartbeat(id); // renew before it lapses
    await sleep(1200);
    expect(await presenceService.isOnline(id)).toBe(true); // alive 2.4 s after the first set, thanks to the renewal
    await sleep(2200);
    expect(await presenceService.isOnline(id)).toBe(false); // heartbeats stopped: gone
    expect(await r.exists(presenceKey(id))).toBe(0);
    await r.quit();
    config.presence_ttl_seconds = original.ttl;
  });

  it('cooldown: five simultaneous attempts by one patient -> exactly one is let through', async () => {
    await makeSettings();
    const patient = await makePatient(100000);
    const docs = await Promise.all(Array.from({ length: 5 }, () => makeDoctor()));
    const results = await Promise.allSettled(
      docs.map((x) => callService.start({ userId: String(patient.user._id), role: 'patient' }, { doctorId: String(x.doctor._id) }, { now: NOON_IST })),
    );
    const ok = results.filter((r) => r.status === 'fulfilled');
    const limited = results.filter((r) => r.status === 'rejected' && (r.reason as { statusCode?: number }).statusCode === 429);
    expect(ok).toHaveLength(1);
    expect(limited).toHaveLength(4);
    expect(await Call.countDocuments({})).toBe(1);
  });

  it('worker: the BullMQ sweep (30 s scheduler, first run immediate) moves a stale ringing call to missed', async () => {
    await makeSettings();
    const patient = await makePatient();
    const doc = await makeDoctor();
    const out = await callService.start({ userId: String(patient.user._id), role: 'patient' }, { doctorId: String(doc.doctor._id) }, { now: NOON_IST });
    await Call.collection.updateOne({ _id: new mongoose.Types.ObjectId(out.callId) }, { $set: { createdAt: new Date(Date.now() - 120_000) } });

    const workers = await startCallWorkers();
    try {
      const moved = await waitFor(async () => (await Call.findById(out.callId).lean())?.status === 'missed');
      expect(moved).toBe(true);
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
  }, 60_000);

  it('worker: a queued finalize job (delayed 3 s) bills the call from its Agora events', async () => {
    await makeSettings();
    const patient = await makePatient(50000);
    const doc = await makeDoctor();
    const out = await callService.start({ userId: String(patient.user._id), role: 'patient' }, { doctorId: String(doc.doctor._id) }, { now: NOON_IST });
    await callService.accept({ userId: String(doc.user._id), role: 'doctor' }, out.callId);
    const call = (await Call.findById(out.callId).lean())!;
    await talk(call, 120);

    const workers = await startCallWorkers();
    try {
      expect(await tryJob('finalize', (j) => j.scheduleFinalize(out.callId, 'real-redis-test'))).toBe(true);
      // the same trigger queued again is a no-op (same job id)
      await tryJob('finalize', (j) => j.scheduleFinalize(out.callId, 'real-redis-test'));
      const done = await waitFor(async () => (await Call.findById(out.callId).lean())?.status === 'completed');
      expect(done).toBe(true);
      expect(await WalletLedger.countDocuments({ idempotencyKey: `call:${out.callId}:charge` })).toBe(1);
      expect((await Call.findById(out.callId).lean())).toMatchObject({ durationSeconds: 120, billedMinutes: 2, grossPaise: 3000 });
    } finally {
      await Promise.all(workers.map((w) => w.close()));
    }
    expect(doubles.agora).toBeTruthy();
  }, 60_000);
});
