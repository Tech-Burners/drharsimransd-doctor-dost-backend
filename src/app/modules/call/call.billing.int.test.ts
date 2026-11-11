// INTEGRATION tests (real replica set): call billing (Phase 6B). A call is started and accepted
// through the real services, Agora events are inserted, and callService.finalize() bills it.
// Nothing in the money path is mocked.
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../../app';
import { useTestDb } from '../../../test/helpers/db';
import {
  Doubles, installDoubles, makeDoctor, makePatient, makeSettings, NOON_IST, removeDoubles, talk, addEvent, topup,
} from '../../../test/helpers/callFixtures';
import { Call } from './call.model';
import { callService } from './call.service';
import { refundService } from '../refund/refund.service';
import { WalletLedger } from '../wallet/walletLedger.model';
import { Wallet } from '../wallet/wallet.model';
import { walletService } from '../wallet/wallet.service';
import { DoctorEarning } from '../doctorEarning/doctorEarning.model';
import { ShortCallAllowance } from '../shortCallAllowance/shortCallAllowance.model';
import { ReconciliationFinding } from '../reconciliationFinding/reconciliationFinding.model';
import { PlatformSetting } from '../platformSetting/platformSetting.model';
import { Doctor } from '../doctor/doctor.model';
import { runInTransaction } from '../../../shared/transaction';
import { WALLET_LEDGER_DIRECTION as DIR, WALLET_LEDGER_TYPE as TYPE } from '../wallet/walletLedger.constants';

describe('Phase 6B: call billing', () => {
  useTestDb();
  let d: Doubles;
  beforeEach(() => {
    d = installDoubles();
  });
  afterAll(removeDoubles);

  const reload = (id: unknown) => Call.findById(id).lean();
  const charges = (callId: unknown) => WalletLedger.countDocuments({ idempotencyKey: `call:${callId}:charge` });

  /** A started AND accepted call. Balance 50000 and rate 1500 by default. */
  const activeCall = async (opts: { balance?: number; patient?: Awaited<ReturnType<typeof makePatient>>; doc?: Awaited<ReturnType<typeof makeDoctor>>; doctorOpts?: Parameters<typeof makeDoctor>[0] } = {}) => {
    await makeSettings();
    const patient = opts.patient ?? (await makePatient(opts.balance ?? 50000));
    const doc = opts.doc ?? (await makeDoctor(opts.doctorOpts));
    const out = await callService.start({ userId: String(patient.user._id), role: 'patient' }, { doctorId: String(doc.doctor._id) }, { now: NOON_IST });
    await callService.accept({ userId: String(doc.user._id), role: 'doctor' }, out.callId);
    return { patient, doc, call: (await reload(out.callId))! };
  };

  // ---------------------------------------------------- the billing table, end to end
  describe('durations and the free short call', () => {
    it('59 s: FREE. No ledger row, no earning, no jobs, not_required, allowance consumed, still in history', async () => {
      const { patient, doc, call } = await activeCall();
      await talk(call, 59);
      expect(await callService.finalize(String(call._id))).toBe('free');

      const done = (await reload(call._id))!;
      expect(done).toMatchObject({
        status: 'completed', durationSeconds: 59, billedMinutes: 0, grossPaise: 0, commissionPaise: 0, netPaise: 0,
        isFreeShortCall: true, prescriptionStatus: 'not_required', prescriptionDeadlineAt: null,
      });
      expect(await charges(call._id)).toBe(0);
      expect(await WalletLedger.countDocuments({ type: 'call_charge' })).toBe(0);
      expect(await DoctorEarning.countDocuments({})).toBe(0);
      expect(d.jobs.prescription).toHaveLength(0);
      expect(await walletService.getBalance(patient.user._id)).toBe(50000);
      const allowance = (await ShortCallAllowance.findOne({}).lean())!;
      expect(String(allowance.patientId)).toBe(String(patient.user._id));
      expect(String(allowance.doctorId)).toBe(String(doc.doctor._id));
      expect(String(allowance.callId)).toBe(String(call._id));

      const history = await request(app).get('/api/v1/calls').set(patient.auth);
      expect(history.body.data[0]).toMatchObject({ isFreeShortCall: true, status: 'completed', grossPaise: 0 });
      expect(d.realtime.to(String(patient.user._id), 'call:ended')[0].payload).toMatchObject({ isFreeShortCall: true, status: 'completed' });
    });

    it('EXACTLY 60 s: billed 1 minute, and the allowance is untouched', async () => {
      const { patient, call } = await activeCall();
      await talk(call, 60);
      expect(await callService.finalize(String(call._id))).toBe('billed');
      expect(await reload(call._id)).toMatchObject({ durationSeconds: 60, billedMinutes: 1, grossPaise: 1500, commissionPaise: 300, netPaise: 1200, isFreeShortCall: false });
      expect(await ShortCallAllowance.countDocuments({})).toBe(0);
      expect(await walletService.getBalance(patient.user._id)).toBe(50000 - 1500);
    });

    it.each([
      [61, 2, 3000], [120, 2, 3000], [121, 3, 4500], [250, 5, 7500],
    ])('%i s bills %i minutes (%i paise)', async (seconds, minutes, gross) => {
      const { call } = await activeCall();
      await talk(call, seconds);
      await callService.finalize(String(call._id));
      expect(await reload(call._id)).toMatchObject({ durationSeconds: seconds, billedMinutes: minutes, grossPaise: gross });
    });

    it('a PAID call writes the debit, the cache, the call fields and a HELD earning, and queues the prescription jobs', async () => {
      const { patient, doc, call } = await activeCall();
      await talk(call, 200);
      const before = Date.now();
      expect(await callService.finalize(String(call._id))).toBe('billed');

      const entry = (await WalletLedger.findOne({ idempotencyKey: `call:${call._id}:charge` }).lean())!;
      expect(entry).toMatchObject({ type: 'call_charge', direction: 'debit', amountPaise: 6000, balanceAfterPaise: 44000, referenceType: 'call' });
      expect(String(entry.referenceId)).toBe(String(call._id));
      expect((await Wallet.findOne({ userId: patient.user._id }))!.balancePaise).toBe(44000);

      const earning = (await DoctorEarning.findOne({ callId: call._id }).lean())!;
      expect(earning).toMatchObject({ grossPaise: 6000, commissionPaise: 1200, netPaise: 4800, status: 'held' });
      expect(String(earning.doctorId)).toBe(String(doc.doctor._id));

      const done = (await reload(call._id))!;
      expect(done.prescriptionStatus).toBe('pending');
      const deadline = done.prescriptionDeadlineAt!.getTime();
      expect(deadline).toBeGreaterThanOrEqual(before + 119 * 60_000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 121 * 60_000);
      expect(d.jobs.prescription).toEqual([{ callId: String(call._id), reminderDelayMs: 60 * 60_000, expiryDelayMs: 120 * 60_000 }]);
    });

    it('the first short call to a doctor is free; a second within 24 h to the SAME doctor is billed 1 minute', async () => {
      const first = await activeCall();
      await talk(first.call, 30);
      expect(await callService.finalize(String(first.call._id))).toBe('free');

      d.redis.advance(60);
      const second = await activeCall({ patient: first.patient, doc: first.doc });
      await talk(second.call, 30);
      expect(await callService.finalize(String(second.call._id))).toBe('billed');
      const done = (await reload(second.call._id))!;
      expect(done).toMatchObject({ durationSeconds: 30, billedMinutes: 1, grossPaise: 1500, isFreeShortCall: false, prescriptionStatus: 'pending' });
      expect(await DoctorEarning.countDocuments({ callId: second.call._id })).toBe(1);
      expect(await ShortCallAllowance.countDocuments({})).toBe(1);
    });

    it('a short call to a DIFFERENT doctor within 24 h is still free', async () => {
      const first = await activeCall();
      await talk(first.call, 30);
      await callService.finalize(String(first.call._id));
      d.redis.advance(60);
      const other = await activeCall({ patient: first.patient });
      await talk(other.call, 20);
      expect(await callService.finalize(String(other.call._id))).toBe('free');
      expect(await ShortCallAllowance.countDocuments({})).toBe(2);
    });

    it('once the allowance expires (TTL) the pair gets a free short call again', async () => {
      const first = await activeCall();
      await talk(first.call, 30);
      await callService.finalize(String(first.call._id));
      await ShortCallAllowance.deleteMany({}); // what the TTL monitor does after 24 h
      d.redis.advance(60);
      const again = await activeCall({ patient: first.patient, doc: first.doc });
      await talk(again.call, 30);
      expect(await callService.finalize(String(again.call._id))).toBe('free');
    });

    it('two concurrent call-end handlers for the SAME pair: exactly one gets the free slot', async () => {
      // The in-flight unique indexes normally make two simultaneous calls for one pair impossible;
      // drop them for this test only so the allowance race itself can be exercised.
      await Call.collection.dropIndex('doctorId_1').catch(() => undefined);
      await Call.collection.dropIndex('patientId_1').catch(() => undefined);
      try {
        const one = await activeCall();
        d.redis.advance(60); // clear the call cooldown so the second call can be placed
        const two = await activeCall({ patient: one.patient, doc: one.doc });
        expect(String(one.call._id)).not.toBe(String(two.call._id));
        await talk(one.call, 30);
        await talk(two.call, 30);
        const outcomes = await Promise.all([callService.finalize(String(one.call._id)), callService.finalize(String(two.call._id))]);
        expect(outcomes.slice().sort()).toEqual(['billed', 'free']);
        expect(await ShortCallAllowance.countDocuments({})).toBe(1);
        expect(await WalletLedger.countDocuments({ type: 'call_charge' })).toBe(1);
        expect(await DoctorEarning.countDocuments({})).toBe(1);
      } finally {
        await Call.syncIndexes();
      }
    });

    it('an aborted call-end transaction RELEASES the allowance', async () => {
      const { call } = await activeCall();
      await talk(call, 30);
      const spy = jest.spyOn(Call, 'updateOne').mockRejectedValueOnce(new Error('disk on fire') as never);
      await expect(callService.finalize(String(call._id))).rejects.toThrow('disk on fire');
      spy.mockRestore();
      expect(await ShortCallAllowance.countDocuments({})).toBe(0);
      expect((await reload(call._id))!.status).toBe('active');
      // and a retry still gets the free slot
      expect(await callService.finalize(String(call._id))).toBe('free');
      expect(await ShortCallAllowance.countDocuments({})).toBe(1);
    });
  });

  // ------------------------------------------------------------------ atomicity
  describe('one transaction', () => {
    it('a failure after the debit rolls back the ledger, the cache, the earning and the call fields', async () => {
      const { patient, call } = await activeCall();
      await talk(call, 90);
      const spy = jest.spyOn(DoctorEarning, 'create').mockRejectedValueOnce(new Error('earning insert failed') as never);
      await expect(callService.finalize(String(call._id))).rejects.toThrow('earning insert failed');
      spy.mockRestore();

      expect(await charges(call._id)).toBe(0);
      expect(await walletService.getBalance(patient.user._id)).toBe(50000);
      expect((await Wallet.findOne({ userId: patient.user._id }))!.balancePaise).toBe(50000);
      expect(await DoctorEarning.countDocuments({})).toBe(0);
      expect(await reload(call._id)).toMatchObject({ status: 'active', grossPaise: 0, billedMinutes: 0 });
      expect(d.jobs.prescription).toHaveLength(0);

      expect(await callService.finalize(String(call._id))).toBe('billed'); // retry is clean
      expect(await charges(call._id)).toBe(1);
    });

    it('is idempotent: finalize twice, or five times at once, charges once and creates one earning', async () => {
      const { call } = await activeCall();
      await talk(call, 90);
      const results = await Promise.all(Array.from({ length: 5 }, () => callService.finalize(String(call._id))));
      expect(results.filter((r) => r === 'billed')).toHaveLength(1);
      expect(results.filter((r) => r === 'noop')).toHaveLength(4);
      expect(await callService.finalize(String(call._id))).toBe('noop');
      expect(await charges(call._id)).toBe(1);
      expect(await DoctorEarning.countDocuments({ callId: call._id })).toBe(1);
      expect(d.jobs.prescription).toHaveLength(1);
    });

    it('a top-up landing at the same moment as call end keeps the ledger chain consistent', async () => {
      const { patient, call } = await activeCall({ balance: 20000 });
      await talk(call, 120);
      await Promise.all([callService.finalize(String(call._id)), topup(patient.user._id, 7000)]);
      expect(await walletService.getBalance(patient.user._id)).toBe(20000 + 7000 - 3000);
      let running = 0;
      for (const r of await WalletLedger.find({ userId: patient.user._id }).sort({ createdAt: 1, _id: 1 }).lean()) {
        running += r.direction === 'credit' ? r.amountPaise : -r.amountPaise;
        expect(r.balanceAfterPaise).toBe(running);
      }
      expect((await Wallet.findOne({ userId: patient.user._id }))!.balancePaise).toBe(running);
    });
  });

  // -------------------------------------------------------- snapshot and affordability
  describe('what the bill is made from', () => {
    it('rate and commission come from the SNAPSHOT on the call, never read live', async () => {
      const { call } = await activeCall({ doctorOpts: { commissionPercent: 15 } });
      await Doctor.updateOne({ _id: call.doctorId }, { consultationRateDayPaise: 9000, consultationRateNightPaise: 9000, commissionPercent: 90 });
      await PlatformSetting.updateOne({}, { commissionPct: 90 });
      await talk(call, 60);
      await callService.finalize(String(call._id));
      expect(await reload(call._id)).toMatchObject({ ratePaisePerMin: call.ratePaisePerMin, grossPaise: call.ratePaisePerMin, commissionPaise: Math.round(call.ratePaisePerMin * 0.15), commissionPercentSnapshot: 15 });
    });

    it('AFFORDABLE DURATION is enforced: a call that ran past it is billed only up to it and never overdraws', async () => {
      const { patient, call } = await activeCall({ balance: 10000 }); // 6 minutes at 1500
      expect(call.maxAffordableSeconds).toBe(360);
      await talk(call, 1200); // the cut-off failed and they talked for 20 minutes
      expect(await callService.finalize(String(call._id))).toBe('billed');
      const done = (await reload(call._id))!;
      expect(done.durationSeconds).toBe(1200); // the true duration is kept
      expect(done.billedMinutes).toBe(6);
      expect(done.grossPaise).toBe(9000);
      expect(await walletService.getBalance(patient.user._id)).toBe(1000);
      expect((await Wallet.findOne({ userId: patient.user._id }))!.balancePaise).toBeGreaterThanOrEqual(0);
    });

    it('a cut-off call (low balance) is completed as ended_low_balance and treated EXACTLY like completed: charged, earning held, prescription pending', async () => {
      const { call } = await activeCall({ balance: 10000 });
      await callService.cutOff(String(call._id));
      await talk(call, call.maxAffordableSeconds);
      expect(await callService.finalize(String(call._id))).toBe('billed');
      const done = (await reload(call._id))!;
      expect(done).toMatchObject({ status: 'ended_low_balance', endReason: 'low_balance', billedMinutes: 6, grossPaise: 9000, prescriptionStatus: 'pending' });
      expect(await DoctorEarning.countDocuments({ callId: call._id, status: 'held' })).toBe(1);
      expect(d.jobs.prescription).toHaveLength(1);
    });

    it('who ended the call is recorded from the events: the first to leave', async () => {
      const a = await activeCall();
      await talk(a.call, 90, 'patient');
      await callService.finalize(String(a.call._id));
      expect((await reload(a.call._id))!.endReason).toBe('patient_ended');
      d.redis.advance(60);
      const b = await activeCall();
      await talk(b.call, 90, 'doctor');
      await callService.finalize(String(b.call._id));
      expect((await reload(b.call._id))!.endReason).toBe('doctor_ended');
    });

    it('a retainer doctor: the patient is charged, but NO earning row is written', async () => {
      const { call } = await activeCall({ doctorOpts: { payoutMode: 'retainer' } });
      await talk(call, 120);
      expect(await callService.finalize(String(call._id))).toBe('billed');
      expect(await charges(call._id)).toBe(1);
      expect(await DoctorEarning.countDocuments({})).toBe(0);
    });
  });

  // --------------------------------------------------- when the events do not allow billing
  describe('no billing without Agora evidence (the client is never the source of the duration)', () => {
    it('nobody has left yet: finalize does nothing and the call stays active', async () => {
      const { call } = await activeCall();
      await addEvent(call, 'patient', 'join', 0);
      await addEvent(call, 'doctor', 'join', 1);
      expect(await callService.finalize(String(call._id))).toBe('noop');
      expect(await reload(call._id)).toMatchObject({ status: 'active', durationSeconds: 0, grossPaise: 0 });
      expect(await WalletLedger.countDocuments({ type: 'call_charge' })).toBe(0);
    });

    it('the client "I ended" hint can neither end nor price a call', async () => {
      const { patient, call } = await activeCall();
      await request(app).post(`/api/v1/calls/${call._id}/end`).set(patient.auth).send({ durationSeconds: 5, grossPaise: 0 });
      expect(await callService.finalize(String(call._id))).toBe('noop');
      expect((await reload(call._id))!.status).toBe('active');
    });

    it('they never met in the channel: the call fails with NO money and NO allowance consumed', async () => {
      const { call } = await activeCall();
      await addEvent(call, 'patient', 'join', 0);
      await addEvent(call, 'patient', 'leave', 20);
      await addEvent(call, 'doctor', 'join', 30);
      await addEvent(call, 'doctor', 'leave', 40);
      expect(await callService.finalize(String(call._id))).toBe('failed');
      expect(await reload(call._id)).toMatchObject({ status: 'failed', grossPaise: 0, prescriptionStatus: 'not_required' });
      expect(await ShortCallAllowance.countDocuments({})).toBe(0);
      expect(await WalletLedger.countDocuments({ type: 'call_charge' })).toBe(0);
      expect(await DoctorEarning.countDocuments({})).toBe(0);
    });

    it('if the charge cannot be taken (balance changed under us) the call is closed with no money and an admin is told', async () => {
      const { patient, call } = await activeCall({ balance: 10000 });
      await talk(call, 360); // 9000 due
      await runInTransaction((s) =>
        walletService.append(s, { userId: patient.user._id as never, type: TYPE.CALL_CHARGE, direction: DIR.DEBIT, amountPaise: 5000, idempotencyKey: 'other-debit' }),
      );
      expect(await callService.finalize(String(call._id))).toBe('unaffordable');
      expect(await reload(call._id)).toMatchObject({ status: 'completed', grossPaise: 0, prescriptionStatus: 'not_required' });
      expect(await charges(call._id)).toBe(0);
      expect(await walletService.getBalance(patient.user._id)).toBe(5000); // untouched, never negative
      expect((await ReconciliationFinding.findOne({ checkName: 'call_charge_unaffordable' }).lean())?.severity).toBe('critical');
      expect(await DoctorEarning.countDocuments({})).toBe(0);
    });
  });

  // ---------------------------------------------------- the contract with the refund (Phase 5)
  describe('refund of a billed call', () => {
    it('finds the charge by its key and forfeits the HELD earning created here; the ledger stays consistent', async () => {
      const { patient, call } = await activeCall();
      await talk(call, 180);
      await callService.finalize(String(call._id));
      const adminId = String(new mongoose.Types.ObjectId());

      const res = await refundService.refundCall({ userId: adminId }, { callId: String(call._id), reason: 'Poor audio quality' });
      expect(res.amountPaise).toBe(4500);
      expect(res.earning).toMatchObject({ action: 'forfeited', earningNetPaise: 3600 });
      expect(await walletService.getBalance(patient.user._id)).toBe(50000);
      expect(await DoctorEarning.findOne({ callId: call._id }).lean()).toMatchObject({ status: 'forfeited' });
      await expect(refundService.refundCall({ userId: adminId }, { callId: String(call._id), reason: 'again please' })).rejects.toMatchObject({ statusCode: 409 });
    });

    it('a free short call has no charge, so there is nothing to refund', async () => {
      const { call } = await activeCall();
      await talk(call, 30);
      await callService.finalize(String(call._id));
      await expect(refundService.refundCall({ userId: String(new mongoose.Types.ObjectId()) }, { callId: String(call._id), reason: 'free call' })).rejects.toMatchObject({ statusCode: 409 });
    });
  });
});
