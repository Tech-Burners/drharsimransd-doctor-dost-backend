// INTEGRATION tests (real replica set): the call lifecycle (Phase 6A). Agora, FCM, queues and
// sockets are doubles; the database and every transaction are real. Billing is in
// call.billing.int.test.ts.
import { createHmac } from 'crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../../app';
import config from '../../config';
import { useTestDb } from '../../../test/helpers/db';
import {
  addEvent, Doubles, installDoubles, makeDoctor, makePatient, makeSettings, NOON_IST, removeDoubles, talk,
} from '../../../test/helpers/callFixtures';
import { Call } from './call.model';
import { callService } from './call.service';
import { runCallSweep } from './call.sweep';
import { PlatformSetting } from '../platformSetting/platformSetting.model';
import { AgoraCallEvent } from '../agoraCallEvent/agoraCallEvent.model';
import { WalletLedger } from '../wallet/walletLedger.model';
import { Wallet } from '../wallet/wallet.model';
import { DoctorEarning } from '../doctorEarning/doctorEarning.model';
import { ShortCallAllowance } from '../shortCallAllowance/shortCallAllowance.model';
import { ReconciliationFinding } from '../reconciliationFinding/reconciliationFinding.model';
import { IdempotencyKey } from '../idempotencyKey/idempotencyKey.model';
import { presenceService, presenceKey } from '../presence/presence.service';
import { registerPresenceHandlers } from '../presence/presence.socket';
import { Doctor } from '../doctor/doctor.model';
import * as billing from '../billing/resolveBilling';
import { EventEmitter } from 'events';

describe('Phase 6A: call lifecycle', () => {
  useTestDb();
  let d: Doubles;
  beforeEach(() => {
    d = installDoubles();
  });
  afterAll(removeDoubles);

  const actorOf = (user: { _id: unknown }, role = 'patient') => ({ userId: String(user._id), role });
  const startVia = (auth: Record<string, string>, key: string, body: object) =>
    request(app).post('/api/v1/calls').set(auth).set('Idempotency-Key', key).send(body);
  const reload = (id: unknown) => Call.findById(id).lean();

  // ---------------------------------------------------------------- start
  describe('POST /calls (start)', () => {
    it('creates a ringing call with a fixed rate snapshot and an affordable duration on a minute boundary', async () => {
      await makeSettings();
      const { user, auth } = await makePatient(10000);
      const { doctor, user: docUser } = await makeDoctor({ commissionPercent: 15 });
      const res = await startVia(auth, 'k1', { doctorId: String(doctor._id) });

      expect(res.status).toBe(201);
      const call = (await reload(res.body.data.callId))!;
      expect(call.status).toBe('ringing');
      expect(String(call.patientId)).toBe(String(user._id)); // from the token
      expect(String(call.doctorId)).toBe(String(doctor._id));
      expect(call.ratePaisePerMin).toBe(call.timeSlot === 'day' ? 1500 : 2500);
      expect(call.commissionPercentSnapshot).toBe(15); // the doctor's override, frozen
      expect(call.maxAffordableSeconds % 60).toBe(0);
      expect(call.maxAffordableSeconds).toBe(Math.floor(10000 / call.ratePaisePerMin) * 60);
      expect(call.isUrgent).toBe(false);
      expect(call.agoraUidPatient).not.toBe(call.agoraUidDoctor);

      // the patient gets a token for THEIR uid and this channel; never the doctor's
      expect(res.body.data.agoraToken).toBe(`token:${call.agoraChannelName}:${call.agoraUidPatient}`);
      expect(JSON.stringify(res.body)).not.toContain(call.agoraUidDoctor);
      expect(d.agora.minted).toHaveLength(1);
      expect(d.agora.minted[0].ttlSeconds).toBeGreaterThanOrEqual(call.maxAffordableSeconds + 60);

      // the doctor is told: socket + high priority push
      expect(d.realtime.to(String(docUser._id), 'call:incoming')).toHaveLength(1);
      expect(d.jobs.ringing).toEqual([String(call._id)]);

      // NO money moves when a call starts
      expect(await WalletLedger.countDocuments({ type: 'call_charge' })).toBe(0);
      expect(await DoctorEarning.countDocuments({})).toBe(0);
      expect(await ShortCallAllowance.countDocuments({})).toBe(0);
    });

    it('uses the platform commission when the doctor has no override', async () => {
      await makeSettings({ commissionPct: 25 });
      const { auth } = await makePatient();
      const { doctor } = await makeDoctor({ commissionPercent: null });
      const res = await startVia(auth, 'k1', { doctorId: String(doctor._id) });
      expect((await reload(res.body.data.callId))!.commissionPercentSnapshot).toBe(25);
    });

    it('selects the rate through the IST helper: 19:59 day, 20:00 night, 05:59 night, 06:00 day', async () => {
      await makeSettings();
      const cases: Array<[string, 'day' | 'night', number]> = [
        ['2026-03-10T14:29:00Z', 'day', 1500], // 19:59 IST
        ['2026-03-10T14:30:00Z', 'night', 2500], // 20:00 IST
        ['2026-03-10T00:29:00Z', 'night', 2500], // 05:59 IST
        ['2026-03-10T00:30:00Z', 'day', 1500], // 06:00 IST
      ];
      for (const [iso, slot, rate] of cases) {
        const { user } = await makePatient();
        const { doctor } = await makeDoctor();
        const out = await callService.start(actorOf(user), { doctorId: String(doctor._id) }, { now: new Date(iso) });
        expect([iso, out.timeSlot, out.ratePaisePerMin]).toEqual([iso, slot, rate]);
      }
    });

    it('the rate is fixed at start: changing the doctor rate or the settings later does not touch the call', async () => {
      await makeSettings();
      const { user } = await makePatient();
      const { doctor } = await makeDoctor();
      const out = await callService.start(actorOf(user), { doctorId: String(doctor._id) }, { now: NOON_IST });
      await Doctor.updateOne({ _id: doctor._id }, { consultationRateDayPaise: 9999 });
      await PlatformSetting.updateOne({}, { commissionPct: 99 });
      const call = (await reload(out.callId))!;
      expect(call.ratePaisePerMin).toBe(1500);
      expect(call.commissionPercentSnapshot).toBe(20);
    });

    it('reads the balance from the LEDGER inside the session, not the wallet cache', async () => {
      await makeSettings();
      const { user, auth } = await makePatient(20000);
      const { doctor } = await makeDoctor();
      await Wallet.updateOne({ userId: user._id }, { $set: { balancePaise: 1 } }); // poisoned cache
      const res = await startVia(auth, 'k1', { doctorId: String(doctor._id) });
      expect(res.status).toBe(201);
      const call = (await reload(res.body.data.callId))!;
      expect(call.maxAffordableSeconds).toBe(Math.floor(20000 / call.ratePaisePerMin) * 60);
    });

    it('low balance: 402 and NO call document is written', async () => {
      await makeSettings();
      const { auth } = await makePatient(9999); // below minWalletPaise (10000)
      const { doctor } = await makeDoctor();
      const res = await startVia(auth, 'k1', { doctorId: String(doctor._id) });
      expect(res.status).toBe(402);
      expect(await Call.countDocuments({})).toBe(0);
      expect(d.agora.minted).toHaveLength(0);
      expect(d.jobs.ringing).toHaveLength(0);
    });

    it('a balance above the minimum that still cannot pay for one minute is refused too', async () => {
      await makeSettings();
      const { auth } = await makePatient(10000);
      const { doctor } = await makeDoctor({ day: 20000, night: 20000 });
      const res = await startVia(auth, 'k1', { doctorId: String(doctor._id) });
      expect(res.status).toBe(402);
      expect(await Call.countDocuments({})).toBe(0);
    });

    it('refuses an offline, unapproved, phone-unverified or non-existent doctor, and a self call', async () => {
      await makeSettings();
      const { auth } = await makePatient();
      const offline = await makeDoctor({ online: false });
      expect((await startVia(auth, 'a', { doctorId: String(offline.doctor._id) })).status).toBe(409);
      d.redis.advance(60);
      const pending = await makeDoctor({ approved: false });
      expect((await startVia(auth, 'b', { doctorId: String(pending.doctor._id) })).status).toBe(404);
      d.redis.advance(60);
      const unverified = await makeDoctor({ phoneVerified: false });
      expect((await startVia(auth, 'c', { doctorId: String(unverified.doctor._id) })).status).toBe(409);
      d.redis.advance(60);
      const ghost = new mongoose.Types.ObjectId();
      await presenceService.heartbeat(String(ghost));
      expect((await startVia(auth, 'd', { doctorId: String(ghost) })).status).toBe(404);
      expect(await Call.countDocuments({})).toBe(0);

      // a doctor calling themself
      const self = await makeDoctor();
      const out = callService.start({ userId: String(self.user._id), role: 'doctor' }, { doctorId: String(self.doctor._id) });
      await expect(out).rejects.toMatchObject({ statusCode: 400 });
    });

    it('a doctor with no rate set cannot be called', async () => {
      await makeSettings();
      const { auth } = await makePatient();
      const { doctor } = await makeDoctor({ day: null, night: null });
      expect((await startVia(auth, 'k1', { doctorId: String(doctor._id) })).status).toBe(422);
      expect(await Call.countDocuments({})).toBe(0);
    });

    it('no PlatformSetting document: 503, not a guess', async () => {
      const { auth } = await makePatient();
      const { doctor } = await makeDoctor();
      expect((await startVia(auth, 'k1', { doctorId: String(doctor._id) })).status).toBe(503);
    });

    it('a busy doctor: the second caller gets a clean 409, never a 500, and no call document', async () => {
      await makeSettings();
      const { doctor } = await makeDoctor();
      const a = await makePatient();
      const b = await makePatient();
      expect((await startVia(a.auth, 'a', { doctorId: String(doctor._id) })).status).toBe(201);
      const second = await startVia(b.auth, 'b', { doctorId: String(doctor._id) });
      expect(second.status).toBe(409);
      expect(second.body.message).toMatch(/busy/i);
      expect(await Call.countDocuments({ doctorId: doctor._id })).toBe(1);
    });

    it('two patients ringing one doctor at the SAME moment: exactly one wins', async () => {
      await makeSettings();
      const { doctor } = await makeDoctor();
      const patients = await Promise.all([makePatient(), makePatient(), makePatient()]);
      const results = await Promise.all(patients.map((p, i) => startVia(p.auth, `race-${i}`, { doctorId: String(doctor._id) })));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
      expect(results.some((r) => r.status >= 500)).toBe(false);
      expect(await Call.countDocuments({ doctorId: doctor._id })).toBe(1);
    });

    it('a patient with a call in flight cannot start a second one', async () => {
      await makeSettings();
      const { auth } = await makePatient();
      const one = await makeDoctor();
      const two = await makeDoctor();
      expect((await startVia(auth, 'a', { doctorId: String(one.doctor._id) })).status).toBe(201);
      d.redis.advance(60); // clear the cooldown so the unique index is what answers
      const res = await startVia(auth, 'b', { doctorId: String(two.doctor._id) });
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/already have a call/i);
    });

    it('the cooldown rejects a second attempt inside the window and allows it after', async () => {
      await makeSettings();
      const { auth } = await makePatient();
      const one = await makeDoctor();
      const two = await makeDoctor();
      // first attempt fails (doctor offline in Redis terms) -> still counts? offline is checked BEFORE the cooldown
      const first = await startVia(auth, 'a', { doctorId: String(one.doctor._id) });
      expect(first.status).toBe(201);
      await Call.updateOne({ _id: first.body.data.callId }, { status: 'rejected' }); // free the in-flight slot
      const tooSoon = await startVia(auth, 'b', { doctorId: String(two.doctor._id) });
      expect(tooSoon.status).toBe(429);
      expect(tooSoon.body.message).toMatch(/wait \d+ seconds/);
      d.redis.advance(config.call_cooldown_seconds + 1);
      expect((await startVia(auth, 'c', { doctorId: String(two.doctor._id) })).status).toBe(201);
    });

    it('the cooldown is per patient: another patient is not affected', async () => {
      await makeSettings();
      const a = await makePatient();
      const b = await makePatient();
      const one = await makeDoctor();
      const two = await makeDoctor();
      expect((await startVia(a.auth, 'a', { doctorId: String(one.doctor._id) })).status).toBe(201);
      expect((await startVia(b.auth, 'b', { doctorId: String(two.doctor._id) })).status).toBe(201);
    });

    it('a retried POST with the same Idempotency-Key returns the first response: one call, one token, one push', async () => {
      await makeSettings();
      const { auth } = await makePatient();
      const { doctor } = await makeDoctor();
      const first = await startVia(auth, 'same-key', { doctorId: String(doctor._id) });
      const retry = await startVia(auth, 'same-key', { doctorId: String(doctor._id) });
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(await Call.countDocuments({})).toBe(1);
      expect(d.agora.minted).toHaveLength(1);
      expect(d.jobs.ringing).toHaveLength(1);
      // a different body with the same key is a client bug
      const other = await makeDoctor();
      expect((await startVia(auth, 'same-key', { doctorId: String(other.doctor._id) })).status).toBe(409);
    });

    it('requires an Idempotency-Key, authentication and the patient role', async () => {
      await makeSettings();
      const { auth } = await makePatient();
      const { doctor, auth: docAuth } = await makeDoctor();
      expect((await request(app).post('/api/v1/calls').set(auth).send({ doctorId: String(doctor._id) })).status).toBe(400);
      expect((await request(app).post('/api/v1/calls').set('Idempotency-Key', 'k').send({ doctorId: String(doctor._id) })).status).toBe(401);
      expect((await startVia(docAuth, 'k', { doctorId: String(doctor._id) })).status).toBe(403);
    });

    it('validates the body and ignores any patientId in it', async () => {
      await makeSettings();
      const a = await makePatient();
      const b = await makePatient();
      const { doctor } = await makeDoctor();
      expect((await startVia(a.auth, 'x1', { doctorId: 'nope' })).status).toBe(400);
      expect((await startVia(a.auth, 'x2', { doctorId: String(doctor._id), isUrgent: 'yes' })).status).toBe(400);
      const res = await startVia(a.auth, 'x3', { doctorId: String(doctor._id), patientId: String(b.user._id), ratePaisePerMin: 1, maxAffordableSeconds: 99999 });
      const call = (await reload(res.body.data.callId))!;
      expect(String(call.patientId)).toBe(String(a.user._id));
      expect(call.ratePaisePerMin).not.toBe(1);
      expect(call.maxAffordableSeconds).toBeLessThan(99999);
    });

    it('if the token cannot be minted the call is released (failed), so the doctor is not blocked', async () => {
      await makeSettings();
      const { auth } = await makePatient();
      const { doctor } = await makeDoctor();
      d.agora.failMint = true;
      const res = await startVia(auth, 'k1', { doctorId: String(doctor._id) });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await Call.countDocuments({ status: 'failed' })).toBe(1);
      d.agora.failMint = false;
      d.redis.advance(60);
      const other = await makePatient();
      expect((await startVia(other.auth, 'k2', { doctorId: String(doctor._id) })).status).toBe(201);
    });

    it('a lost ringing-timeout job does not fail the start (the sweep covers it)', async () => {
      await makeSettings();
      const { auth } = await makePatient();
      const { doctor } = await makeDoctor();
      d.jobs.fail = true;
      expect((await startVia(auth, 'k1', { doctorId: String(doctor._id) })).status).toBe(201);
    });

    describe('urgent calls', () => {
      it('use the PlatformSetting urgent rate for the snapshot and the affordable duration', async () => {
        await makeSettings({ urgentCallDayRatePaise: 3000, urgentCallNightRatePaise: 4000 });
        const { user } = await makePatient(20000);
        const { doctor } = await makeDoctor();
        const out = await callService.start(actorOf(user), { doctorId: String(doctor._id), isUrgent: true }, { now: NOON_IST });
        expect(out).toMatchObject({ ratePaisePerMin: 3000, timeSlot: 'day', isUrgent: true, maxAffordableSeconds: Math.floor(20000 / 3000) * 60 });
        expect((await reload(out.callId))!.isUrgent).toBe(true);
      });

      it('a missing, zero or invalid urgent rate is refused (422), writes no call and never gives infinite duration', async () => {
        await makeSettings(); // urgent rates default to 0
        const { auth } = await makePatient();
        const { doctor } = await makeDoctor();
        const res = await startVia(auth, 'k1', { doctorId: String(doctor._id), isUrgent: true });
        expect(res.status).toBe(422);
        expect(res.body.message).toBe('Urgent calls are not available right now');
        expect(await Call.countDocuments({})).toBe(0);
      });

      it('later PlatformSetting changes do not affect the ongoing urgent call', async () => {
        const s = await makeSettings({ urgentCallDayRatePaise: 3000, urgentCallNightRatePaise: 4000 });
        const { user } = await makePatient(20000);
        const { doctor } = await makeDoctor();
        const out = await callService.start(actorOf(user), { doctorId: String(doctor._id), isUrgent: true }, { now: NOON_IST });
        await PlatformSetting.updateOne({ _id: s._id }, { urgentCallDayRatePaise: 9000 });
        expect((await reload(out.callId))!.ratePaisePerMin).toBe(3000);
      });
    });
  });

  // ------------------------------------------------------ accept / reject / missed
  describe('doctor responses', () => {
    const ringing = async () => {
      await makeSettings();
      const patient = await makePatient();
      const doc = await makeDoctor();
      const out = await callService.start(actorOf(patient.user), { doctorId: String(doc.doctor._id) }, { now: NOON_IST });
      return { patient, doc, callId: out.callId };
    };

    it('the doctor accepts: ringing -> active, gets their OWN token and uid, the patient is told', async () => {
      const { patient, doc, callId } = await ringing();
      const res = await request(app).post(`/api/v1/calls/${callId}/accept`).set(doc.auth);
      expect(res.status).toBe(200);
      const call = (await reload(callId))!;
      expect(call.status).toBe('active');
      expect(call.startedAt).toBeTruthy();
      expect(res.body.data.agoraToken).toBe(`token:${call.agoraChannelName}:${call.agoraUidDoctor}`);
      expect(JSON.stringify(res.body)).not.toContain(`:${call.agoraUidPatient}`);
      expect(d.realtime.to(String(patient.user._id), 'call:accepted')).toHaveLength(1);
    });

    it('only the called doctor can accept: a patient, another doctor, or a second accept', async () => {
      const { patient, doc, callId } = await ringing();
      const other = await makeDoctor();
      expect((await request(app).post(`/api/v1/calls/${callId}/accept`).set(patient.auth)).status).toBe(403);
      expect((await request(app).post(`/api/v1/calls/${callId}/accept`).set(other.auth)).status).toBe(404);
      expect((await request(app).post(`/api/v1/calls/${callId}/accept`).set(doc.auth)).status).toBe(200);
      expect((await request(app).post(`/api/v1/calls/${callId}/accept`).set(doc.auth)).status).toBe(409);
      expect((await reload(callId))!.status).toBe('active');
    });

    it('reject frees both parties', async () => {
      const { patient, doc, callId } = await ringing();
      expect((await request(app).post(`/api/v1/calls/${callId}/reject`).set(doc.auth)).status).toBe(200);
      const call = (await reload(callId))!;
      expect(call).toMatchObject({ status: 'rejected', endReason: 'doctor_rejected' });
      expect(d.realtime.to(String(patient.user._id), 'call:rejected')).toHaveLength(1);
      d.redis.advance(60);
      expect((await request(app).post('/api/v1/calls').set(patient.auth).set('Idempotency-Key', 'again').send({ doctorId: String(doc.doctor._id) })).status).toBe(201);
    });

    it('a call nobody answers becomes missed, safely repeatable, and does nothing once answered', async () => {
      const { doc, callId } = await ringing();
      expect(await callService.markMissed(callId)).toBe(true);
      expect(await callService.markMissed(callId)).toBe(false);
      expect((await reload(callId))).toMatchObject({ status: 'missed', endReason: 'doctor_missed' });
      expect((await request(app).post(`/api/v1/calls/${callId}/accept`).set(doc.auth)).status).toBe(409);

      const second = await ringing();
      await request(app).post(`/api/v1/calls/${second.callId}/accept`).set(second.doc.auth);
      expect(await callService.markMissed(second.callId)).toBe(false); // already active: untouched
      expect((await reload(second.callId))!.status).toBe('active');
    });

    it('"I ended the call" is only a hint: no state change, no duration, and only for a party', async () => {
      const { patient, doc, callId } = await ringing();
      await request(app).post(`/api/v1/calls/${callId}/accept`).set(doc.auth);
      const stranger = await makePatient();
      expect((await request(app).post(`/api/v1/calls/${callId}/end`).set(stranger.auth).send({ durationSeconds: 5 })).status).toBe(404);
      const res = await request(app).post(`/api/v1/calls/${callId}/end`).set(patient.auth).send({ durationSeconds: 5, grossPaise: 0 });
      expect(res.status).toBe(202);
      const call = (await reload(callId))!;
      expect(call.status).toBe('active'); // nothing changed
      expect(call.durationSeconds).toBe(0);
      expect(d.jobs.finalize).toHaveLength(1); // only a look at the Agora events was requested
      expect(await WalletLedger.countDocuments({ type: 'call_charge' })).toBe(0);
    });

    it('accept arms the cut-off: a warning 60 s before and a cut-off at the affordable duration', async () => {
      const { patient, doc, callId } = await ringing();
      const spy = jest.spyOn(global, 'setTimeout');
      await request(app).post(`/api/v1/calls/${callId}/accept`).set(doc.auth);
      const call = (await reload(callId))!;
      const cutoffMs = call.maxAffordableSeconds * 1000;
      const scheduled = spy.mock.calls.filter((c) => typeof c[1] === 'number' && (c[1] as number) > 10_000);
      spy.mockRestore();
      const near = (ms: number) => scheduled.find((c) => Math.abs((c[1] as number) - ms) < 5000);
      const warn = near(cutoffMs - 60_000);
      const cut = near(cutoffMs);
      expect(warn).toBeTruthy();
      expect(cut).toBeTruthy();

      (warn![0] as () => void)();
      expect(d.realtime.to(String(patient.user._id), 'call:warning')).toHaveLength(1);
      expect(d.realtime.to(String(doc.user._id), 'call:warning')).toHaveLength(1);

      (cut![0] as () => void)();
      await new Promise((r) => setTimeout(r, 200));
      expect((await reload(callId))!.endReason).toBe('low_balance');
      expect(d.agora.closed).toHaveLength(1);
      expect(d.agora.closed[0].uids.sort()).toEqual([Number(call.agoraUidPatient), Number(call.agoraUidDoctor)].sort());
    });
  });

  // ---------------------------------------------------------------- history
  describe('call history', () => {
    it('lists only your own calls and labels free short calls with isFreeShortCall', async () => {
      await makeSettings();
      const a = await makePatient();
      const b = await makePatient();
      const doc = await makeDoctor();
      const out = await callService.start(actorOf(a.user), { doctorId: String(doc.doctor._id) }, { now: NOON_IST });
      await Call.updateOne({ _id: out.callId }, { status: 'completed', isFreeShortCall: true });

      const mine = await request(app).get('/api/v1/calls').set(a.auth);
      expect(mine.body.data).toHaveLength(1);
      expect(mine.body.data[0]).toMatchObject({ isFreeShortCall: true, status: 'completed' });
      expect(mine.body.data[0].agoraUidDoctor).toBeUndefined(); // no Agora internals
      expect(mine.body.meta).toMatchObject({ page: 1, total: 1 });

      expect((await request(app).get('/api/v1/calls').set(b.auth)).body.data).toHaveLength(0);
      expect((await request(app).get(`/api/v1/calls/${out.callId}`).set(b.auth)).status).toBe(404);
      expect((await request(app).get(`/api/v1/calls/${out.callId}`).set(a.auth)).status).toBe(200);
      expect((await request(app).get('/api/v1/calls').set(doc.auth)).body.data).toHaveLength(1);
      expect((await request(app).get('/api/v1/calls')).status).toBe(401);
    });
  });

  // ---------------------------------------------------------------- webhook
  describe('POST /webhooks/agora/call', () => {
    const SECRET = 'agora-test-secret';
    const sig = {
      v1: (raw: string, secret = SECRET) => createHmac('sha1', secret).update(raw).digest('hex'),
      v2: (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex'),
    };
    const envelope = (channelName: string, uid: string, eventType: number, clientSeq: number, ts: number, extra: object = {}) => ({
      noticeId: `notice-${Math.random()}`, productId: 1, eventType, notifyMs: Date.now(),
      payload: { channelName, uid: Number(uid), platform: 1, clientSeq, ts, ...extra },
    });
    const post = (body: object | string, headers: Record<string, string> = {}) => {
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      return request(app).post('/api/v1/webhooks/agora/call').set('Content-Type', 'application/json').set(headers).send(raw);
    };
    const activeCall = async () => {
      await makeSettings();
      const patient = await makePatient();
      const doc = await makeDoctor();
      const out = await callService.start(actorOf(patient.user), { doctorId: String(doc.doctor._id) }, { now: NOON_IST });
      await callService.accept({ userId: String(doc.user._id), role: 'doctor' }, out.callId);
      return (await reload(out.callId))!;
    };

    it('drops a request with a missing, wrong or tampered signature: nothing is stored', async () => {
      const call = await activeCall();
      const body = JSON.stringify(envelope(call.agoraChannelName, call.agoraUidPatient, 108, 5, 1_700_000_000));
      expect((await post(body)).status).toBe(401);
      expect((await post(body, { 'Agora-Signature-V2': sig.v2(body, 'wrong') })).status).toBe(401);
      expect((await post(body, { 'Agora-Signature': sig.v1(body, 'wrong') })).status).toBe(401);
      expect((await post(body.replace('108', '107'), { 'Agora-Signature-V2': sig.v2(body) })).status).toBe(401); // signed another body
      expect(await AgoraCallEvent.countDocuments({})).toBe(0);
      expect(d.jobs.finalize).toHaveLength(0);
    });

    it('a forged leave event can never shorten a call (no signature, no effect)', async () => {
      const call = await activeCall();
      await addEvent(call, 'patient', 'join', 0);
      await addEvent(call, 'doctor', 'join', 1);
      const forged = JSON.stringify(envelope(call.agoraChannelName, call.agoraUidPatient, 108, 99999, 1_700_000_100));
      expect((await post(forged)).status).toBe(401);
      expect(await AgoraCallEvent.countDocuments({ eventType: '108' })).toBe(0);
      expect(await callService.finalize(String(call._id))).toBe('noop');
      expect((await reload(call._id))!.status).toBe('active');
    });

    it('V2 is preferred and must match: a valid V1 next to a bad V2 is still rejected', async () => {
      const call = await activeCall();
      const body = JSON.stringify(envelope(call.agoraChannelName, call.agoraUidPatient, 107, 1, 1_700_000_000));
      expect((await post(body, { 'Agora-Signature': sig.v1(body), 'Agora-Signature-V2': sig.v2(body, 'wrong') })).status).toBe(401);
      expect((await post(body, { 'Agora-Signature-V2': sig.v2(body) })).status).toBe(200);
    });

    it('accepts the SHA1 header when it is the only one sent', async () => {
      const call = await activeCall();
      const body = JSON.stringify(envelope(call.agoraChannelName, call.agoraUidDoctor, 107, 2, 1_700_000_000));
      expect((await post(body, { 'Agora-Signature': sig.v1(body) })).status).toBe(200);
    });

    it('fails closed when no webhook secret is configured', async () => {
      const call = await activeCall();
      config.agora.webhookSecret = undefined;
      const body = JSON.stringify(envelope(call.agoraChannelName, call.agoraUidPatient, 107, 1, 1_700_000_000));
      expect((await post(body, { 'Agora-Signature-V2': sig.v2(body, '') })).status).toBe(401);
      expect(await AgoraCallEvent.countDocuments({})).toBe(0);
    });

    it('stores the event FIRST (ts is seconds), answers with JSON, and a duplicate is a no-op', async () => {
      const call = await activeCall();
      const ts = 1_700_000_000;
      const body = JSON.stringify(envelope(call.agoraChannelName, call.agoraUidPatient, 107, 777, ts));
      const first = await post(body, { 'Agora-Signature-V2': sig.v2(body) });
      expect(first.status).toBe(200);
      expect(first.headers['content-type']).toMatch(/json/);
      expect(first.body.data).toEqual({ stored: true });
      const row = (await AgoraCallEvent.findOne({}).lean())!;
      expect(row.eventTs.getTime()).toBe(ts * 1000);
      expect(row.uid).toBe(call.agoraUidPatient);
      expect(row.eventType).toBe('107');
      expect(row.providerEventId).toBe(`${call.agoraChannelName}:${call.agoraUidPatient}:107:777`);

      // Agora retries: same event, a NEW noticeId and notifyMs -> still a duplicate
      const retry = JSON.stringify({ ...JSON.parse(body), noticeId: 'another', notifyMs: Date.now() + 5000 });
      const again = await post(retry, { 'Agora-Signature-V2': sig.v2(retry) });
      expect(again.status).toBe(200);
      expect(again.body.data).toEqual({ duplicate: true });
      expect(await AgoraCallEvent.countDocuments({})).toBe(1);
    });

    it('a leave on an active call asks for a (delayed) finalize; a join does not; a leave while ringing does not', async () => {
      const call = await activeCall();
      const join = JSON.stringify(envelope(call.agoraChannelName, call.agoraUidPatient, 107, 1, 1_700_000_000));
      await post(join, { 'Agora-Signature-V2': sig.v2(join) });
      expect(d.jobs.finalize).toHaveLength(0);
      const leave = JSON.stringify(envelope(call.agoraChannelName, call.agoraUidPatient, 108, 2, 1_700_000_060));
      await post(leave, { 'Agora-Signature-V2': sig.v2(leave) });
      expect(d.jobs.finalize).toHaveLength(1);
      expect(d.jobs.finalize[0].callId).toBe(String(call._id));

      // ringing call: stored, but nothing to finalize
      const patient2 = await makePatient();
      const doc2 = await makeDoctor();
      const out2 = await callService.start(actorOf(patient2.user), { doctorId: String(doc2.doctor._id) }, { now: NOON_IST });
      const c2 = (await reload(out2.callId))!;
      const leave2 = JSON.stringify(envelope(c2.agoraChannelName, c2.agoraUidPatient, 108, 3, 1_700_000_070));
      await post(leave2, { 'Agora-Signature-V2': sig.v2(leave2) });
      expect(d.jobs.finalize).toHaveLength(1);
    });

    it('acknowledges and ignores what is not ours: unknown channel, test event, foreign uid, other products, other event types', async () => {
      const call = await activeCall();
      const ok = (b: object) => post(JSON.stringify(b), { 'Agora-Signature-V2': sig.v2(JSON.stringify(b)) });
      expect((await ok(envelope('test_webhook', '12121212', 107, 1, 1_700_000_000))).body.data.reason).toBe('unknown channel');
      expect((await ok(envelope(call.agoraChannelName, '424242', 107, 1, 1_700_000_000))).body.data.reason).toMatch(/not a party/);
      expect((await ok({ ...envelope(call.agoraChannelName, call.agoraUidPatient, 107, 1, 1_700_000_000), productId: 3 })).body.data.reason).toMatch(/not an RTC/);
      expect((await ok({ noticeId: 'x', productId: 1, eventType: 101, payload: { channelName: call.agoraChannelName, ts: 1 } })).body.data.reason).toMatch(/not a join or leave/);
      expect((await ok({ noticeId: 'x', productId: 1, eventType: 107, payload: { channelName: call.agoraChannelName } })).body.data.reason).toMatch(/missing/);
      expect(await AgoraCallEvent.countDocuments({})).toBe(0);
    });

    it('a malformed body with a valid signature is a 400', async () => {
      const raw = '{broken';
      expect((await post(raw, { 'Agora-Signature-V2': sig.v2(raw) })).status).toBe(400);
    });

    it('end to end: signed leave events -> finalize -> the call is billed from the EVENTS', async () => {
      await makeSettings();
      const patient = await makePatient(50000);
      const doc = await makeDoctor();
      const out = await callService.start(actorOf(patient.user), { doctorId: String(doc.doctor._id) }, { now: NOON_IST });
      await callService.accept({ userId: String(doc.user._id), role: 'doctor' }, out.callId);
      const call = (await reload(out.callId))!;
      const base = 1_700_000_000;
      for (const [uid, type, seq, ts] of [
        [call.agoraUidPatient, 107, 1, base], [call.agoraUidDoctor, 107, 2, base + 2],
        [call.agoraUidPatient, 108, 3, base + 182], [call.agoraUidDoctor, 108, 4, base + 183],
      ] as const) {
        const b = JSON.stringify(envelope(call.agoraChannelName, uid, type, seq, ts));
        expect((await post(b, { 'Agora-Signature-V2': sig.v2(b) })).status).toBe(200);
      }
      expect(d.jobs.finalize.length).toBeGreaterThan(0);
      // the worker would run the delayed job; run it now
      expect(await callService.finalize(String(call._id))).toBe('billed');
      const done = (await reload(call._id))!;
      expect(done).toMatchObject({ status: 'completed', durationSeconds: 180, billedMinutes: 3, grossPaise: 4500, isFreeShortCall: false });
      expect(await WalletLedger.countDocuments({ idempotencyKey: `call:${call._id}:charge` })).toBe(1);
    });
  });

  // ---------------------------------------------------------------- presence
  describe('doctor presence', () => {
    it('the key expires after the TTL, a heartbeat renews it, and starting a call to an expired doctor is refused', async () => {
      await makeSettings();
      const { doctor } = await makeDoctor({ online: false });
      const id = String(doctor._id);
      expect(await presenceService.isOnline(id)).toBe(false);
      await presenceService.heartbeat(id);
      expect(await presenceService.isOnline(id)).toBe(true);
      expect(await d.redis.ttl(presenceKey(id))).toBeLessThanOrEqual(90);
      d.redis.advance(60);
      expect(await presenceService.isOnline(id)).toBe(true);
      await presenceService.heartbeat(id); // the 30 s heartbeat renews the full TTL
      d.redis.advance(60);
      expect(await presenceService.isOnline(id)).toBe(true);
      d.redis.advance(31); // 91 s since the last heartbeat
      expect(await presenceService.isOnline(id)).toBe(false);

      const { auth } = await makePatient();
      expect((await request(app).post('/api/v1/calls').set(auth).set('Idempotency-Key', 'k').send({ doctorId: id })).status).toBe(409);
    });

    it('a heartbeat is ONE Redis write and NO Mongo write', async () => {
      const { doctor } = await makeDoctor({ online: false });
      const spy = jest.spyOn(Doctor, 'updateOne');
      const spy2 = jest.spyOn(Doctor, 'findOneAndUpdate');
      for (let i = 0; i < 20; i += 1) await presenceService.heartbeat(String(doctor._id));
      expect(spy).not.toHaveBeenCalled();
      expect(spy2).not.toHaveBeenCalled();
      spy.mockRestore();
      spy2.mockRestore();
    });

    it('going online sets the key and the Mongo cache; going offline clears both', async () => {
      const { user, doctor } = await makeDoctor({ online: false });
      expect(await presenceService.goOnline(String(user._id))).toBe(String(doctor._id));
      expect(await presenceService.isOnline(String(doctor._id))).toBe(true);
      expect((await Doctor.findById(doctor._id).lean())!.isOnline).toBe(true);
      await presenceService.goOffline(String(doctor._id));
      expect(await presenceService.isOnline(String(doctor._id))).toBe(false);
      expect((await Doctor.findById(doctor._id).lean())!.isOnline).toBe(false);
    });

    it('a doctor whose phone is not verified cannot appear online', async () => {
      const { user, doctor } = await makeDoctor({ online: false, phoneVerified: false });
      expect(await presenceService.goOnline(String(user._id))).toBeNull();
      expect(await presenceService.isOnline(String(doctor._id))).toBe(false);
      expect((await Doctor.findById(doctor._id).lean())!.isOnline).toBe(false);
    });

    describe('socket handlers', () => {
      const fakeSocket = (user: { _id: string; role: string }) => {
        const s = new EventEmitter() as EventEmitter & { user: typeof user };
        s.user = user;
        return s;
      };
      const settle = () => new Promise((r) => setTimeout(r, 120));

      it('connect sets presence; the `presence` event renews it; go-offline and the last disconnect clear it', async () => {
        const { user, doctor } = await makeDoctor({ online: false });
        const sockets: unknown[] = [];
        const io = { in: () => ({ fetchSockets: async () => sockets }) };
        const sock = fakeSocket({ _id: String(user._id), role: 'doctor' });
        sockets.push(sock);
        registerPresenceHandlers(io as never, sock as never);
        await settle();
        expect(await presenceService.isOnline(String(doctor._id))).toBe(true);

        d.redis.advance(80);
        sock.emit('presence');
        await settle();
        d.redis.advance(80);
        expect(await presenceService.isOnline(String(doctor._id))).toBe(true); // renewed at +80, still alive at +160

        sock.emit('go-offline');
        await settle();
        expect(await presenceService.isOnline(String(doctor._id))).toBe(false);

        sock.emit('presence'); // still connected: the heartbeat brings them back
        await settle();
        expect(await presenceService.isOnline(String(doctor._id))).toBe(true);
        sockets.length = 0;
        sock.emit('disconnect');
        await settle();
        expect(await presenceService.isOnline(String(doctor._id))).toBe(false);
        expect((await Doctor.findById(doctor._id).lean())!.isOnline).toBe(false);
      });

      it('one device disconnecting does not take a doctor with a second device offline', async () => {
        const { user, doctor } = await makeDoctor({ online: false });
        const a = fakeSocket({ _id: String(user._id), role: 'doctor' });
        const b = fakeSocket({ _id: String(user._id), role: 'doctor' });
        const live: unknown[] = [a, b];
        const io = { in: () => ({ fetchSockets: async () => live }) };
        registerPresenceHandlers(io as never, a as never);
        registerPresenceHandlers(io as never, b as never);
        await settle();
        live.splice(live.indexOf(a), 1);
        a.emit('disconnect');
        await settle();
        expect(await presenceService.isOnline(String(doctor._id))).toBe(true);
        live.length = 0;
        b.emit('disconnect');
        await settle();
        expect(await presenceService.isOnline(String(doctor._id))).toBe(false);
      });

      it('patients get no presence handlers', async () => {
        const sock = fakeSocket({ _id: String(new mongoose.Types.ObjectId()), role: 'patient' });
        registerPresenceHandlers({ in: () => ({ fetchSockets: async () => [] }) } as never, sock as never);
        expect(sock.listenerCount('presence')).toBe(0);
      });
    });
  });

  // ------------------------------------------------------------------ sweep
  describe('the 30 second overdue-call sweep', () => {
    const activeCall = async (balance = 50000) => {
      await makeSettings();
      const patient = await makePatient(balance);
      const doc = await makeDoctor();
      const out = await callService.start(actorOf(patient.user), { doctorId: String(doc.doctor._id) }, { now: NOON_IST });
      await callService.accept({ userId: String(doc.user._id), role: 'doctor' }, out.callId);
      return { patient, doc, call: (await reload(out.callId))! };
    };
    const startedAgo = (callId: unknown, seconds: number) =>
      Call.updateOne({ _id: callId }, { startedAt: new Date(Date.now() - seconds * 1000), answeredAt: new Date(Date.now() - seconds * 1000) });

    it('moves a stale ringing call to missed (a lost job) and leaves a fresh one alone', async () => {
      await makeSettings();
      const a = await makePatient();
      const b = await makePatient();
      const one = await makeDoctor();
      const two = await makeDoctor();
      const stale = await callService.start(actorOf(a.user), { doctorId: String(one.doctor._id) }, { now: NOON_IST });
      const fresh = await callService.start(actorOf(b.user), { doctorId: String(two.doctor._id) }, { now: NOON_IST });
      await Call.collection.updateOne({ _id: new mongoose.Types.ObjectId(stale.callId) }, { $set: { createdAt: new Date(Date.now() - 120_000) } }); // createdAt is immutable in Mongoose
      const stats = await runCallSweep();
      expect(stats.missed).toBe(1);
      expect((await reload(stale.callId))!.status).toBe('missed');
      expect((await reload(fresh.callId))!.status).toBe('ringing');
    });

    it('leaves an active call within its affordable duration alone', async () => {
      const { call } = await activeCall();
      await startedAgo(call._id, 30);
      const stats = await runCallSweep();
      expect(stats).toMatchObject({ cutOff: 0, closedNoEndEvent: 0, finalized: 0 });
      expect((await reload(call._id))!.status).toBe('active');
    });

    it('CONDITION A: past the affordable duration -> cut off (reason low_balance, channel closed), still active until the events arrive', async () => {
      const { call } = await activeCall();
      await startedAgo(call._id, call.maxAffordableSeconds + 10);
      const stats = await runCallSweep();
      expect(stats.cutOff).toBe(1);
      expect(stats.closedNoEndEvent).toBe(0);
      expect(d.agora.closed).toHaveLength(1);
      const after = (await reload(call._id))!;
      expect(after.status).toBe('active');
      expect(after.endReason).toBe('low_balance');
    });

    it('CONDITION B: past the hard ceiling with no way to derive a duration -> closed, NO money, critical finding', async () => {
      const { call, doc } = await activeCall();
      await startedAgo(call._id, call.maxAffordableSeconds + config.call_orphan_grace_seconds + 30);
      const resolveSpy = jest.spyOn(billing, 'resolveBilling');

      const stats = await runCallSweep();
      expect(stats.closedNoEndEvent).toBe(1);
      const closed = (await reload(call._id))!;
      expect(closed).toMatchObject({
        status: 'completed', endReason: 'no_end_event', durationSeconds: 0, billedMinutes: 0,
        grossPaise: 0, commissionPaise: 0, netPaise: 0, isFreeShortCall: false, prescriptionStatus: 'not_required',
      });
      expect(await WalletLedger.countDocuments({ type: 'call_charge' })).toBe(0); // NO ledger entry
      expect(await DoctorEarning.countDocuments({})).toBe(0); // NO earning
      expect(await ShortCallAllowance.countDocuments({})).toBe(0); // NO allowance consumed
      expect(d.jobs.prescription).toHaveLength(0); // NO jobs
      expect(resolveSpy).not.toHaveBeenCalled(); // a NO_END_EVENT call never reaches resolveBilling
      resolveSpy.mockRestore();

      const finding = (await ReconciliationFinding.findOne({ checkName: 'call_no_end_event' }).lean())!;
      expect(finding.severity).toBe('critical');
      expect(String(finding.entityId)).toBe(String(call._id));

      // the doctor is free again (the in-flight unique index no longer holds them)
      d.redis.advance(60);
      const other = await makePatient();
      const next = await request(app).post('/api/v1/calls').set(other.auth).set('Idempotency-Key', 'next').send({ doctorId: String(doc.doctor._id) });
      expect(next.status).toBe(201);
    });

    it('is idempotent: a second sweep changes nothing', async () => {
      const { call } = await activeCall();
      await startedAgo(call._id, call.maxAffordableSeconds + config.call_orphan_grace_seconds + 30);
      await runCallSweep();
      const snapshot = JSON.stringify(await reload(call._id));
      const again = await runCallSweep();
      expect(again.closedNoEndEvent).toBe(0);
      expect(JSON.stringify(await reload(call._id))).toBe(snapshot);
      expect(await ReconciliationFinding.countDocuments({ checkName: 'call_no_end_event' })).toBe(1);
    });

    it('a call far past its ceiling that DOES have a derivable duration is billed, not closed as no-end-event', async () => {
      const { call } = await activeCall();
      await talk(call, 120);
      await startedAgo(call._id, call.maxAffordableSeconds + config.call_orphan_grace_seconds + 30);
      const stats = await runCallSweep();
      expect(stats.finalized).toBe(1);
      expect(stats.closedNoEndEvent).toBe(0);
      expect((await reload(call._id))).toMatchObject({ status: 'completed', durationSeconds: 120 });
      expect(await WalletLedger.countDocuments({ type: 'call_charge' })).toBe(1);
    });

    it('finalizes an ended call whose finalize job was lost', async () => {
      const { call } = await activeCall();
      await talk(call, 75);
      const stats = await runCallSweep();
      expect(stats.finalized).toBe(1);
      expect((await reload(call._id))!.durationSeconds).toBe(75);
    });

    it('if Agora cannot close the channel the cut-off is logged and the sweep carries on; condition B still closes the call', async () => {
      const { call } = await activeCall();
      d.agora.failClose = true;
      await startedAgo(call._id, call.maxAffordableSeconds + 10);
      const stats = await runCallSweep();
      expect(stats.cutOff).toBe(0);
      expect(stats.errors).toBe(0);
      await startedAgo(call._id, call.maxAffordableSeconds + config.call_orphan_grace_seconds + 30);
      expect((await runCallSweep()).closedNoEndEvent).toBe(1);
    });

    it('one broken call does not stop the sweep', async () => {
      const { call } = await activeCall();
      await startedAgo(call._id, call.maxAffordableSeconds + config.call_orphan_grace_seconds + 30);
      const spy = jest.spyOn(callService, 'cutOff').mockRejectedValueOnce(new Error('boom'));
      const stats = await runCallSweep();
      spy.mockRestore();
      expect(stats.errors).toBe(1);
      expect((await runCallSweep()).closedNoEndEvent).toBe(1);
    });
  });

  // not used elsewhere in this file but part of the shared fixture contract
  it('fixtures: IdempotencyKey is released when a start fails (the client can retry)', async () => {
    await makeSettings();
    const { auth } = await makePatient(100); // too poor
    const { doctor } = await makeDoctor();
    expect((await startVia(auth, 'poor', { doctorId: String(doctor._id) })).status).toBe(402);
    expect(await IdempotencyKey.countDocuments({ key: 'poor' })).toBe(0);
  });
});
