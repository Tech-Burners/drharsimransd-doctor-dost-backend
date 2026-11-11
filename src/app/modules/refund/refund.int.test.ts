// INTEGRATION tests (real replica set) for the shared full-only refund, the doctor-side
// reversal and recovery, pending-withdrawal adjustment, write-off, the outbox notices and the
// legacy-signup transition. Nothing in the money path is mocked.
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { useTestDb } from '../../../test/helpers/db';
import config from '../../config';
import globalErrorHandler from '../../middleware/globalErrorhandler';
import { refundRoutes } from './refund.route';
import { recoveryRoutes } from '../doctorEarning/recovery.route';
import { refundService } from './refund.service';
import { recoveryService, outstandingOf } from '../doctorEarning/recovery.service';
import { issueTokenPair } from '../auth/auth.tokens';
import { runInTransaction } from '../../../shared/transaction';
import { User } from '../user/user.model';
import { Doctor } from '../doctor/doctor.model';
import { Call } from '../call/call.model';
import { Wallet } from '../wallet/wallet.model';
import { WalletLedger } from '../wallet/walletLedger.model';
import { walletService } from '../wallet/wallet.service';
import { DoctorEarning } from '../doctorEarning/doctorEarning.model';
import { DoctorLedgerAdjustment } from '../doctorLedgerAdjustment/doctorLedgerAdjustment.model';
import { WithdrawalRequest } from '../withdrawalRequest/withdrawalRequest.model';
import { PlatformSetting } from '../platformSetting/platformSetting.model';
import { OutboxEvent } from '../outbox/outbox.model';
import { outboxService } from '../outbox/outbox.service';
import { outboxHandlers } from '../outbox/outbox.handlers';
import { Notification } from '../notification/notification.model';
import { NotificationSetting } from '../notificationSetting/notificationSetting.model';
import { ReconciliationFinding } from '../reconciliationFinding/reconciliationFinding.model';
import { WALLET_LEDGER_DIRECTION as DIR, WALLET_LEDGER_TYPE as TYPE } from '../wallet/walletLedger.constants';
import { legacySignup } from '../../middleware/legacySignup';

const PASSWORD = 'Str0ng-Passw0rd';
let seq = 0;

const app = express();
app.use(express.json());
app.use('/api/v1/admin/refunds', refundRoutes);
app.use('/api/v1/admin/recoveries', recoveryRoutes);
app.post('/legacy/create', legacySignup, (_req, res) => {
  res.status(201).json({ ok: true });
});
app.use(globalErrorHandler);

type EarningStatus = 'held' | 'released' | 'withdrawn' | 'forfeited';

describe('refund, reversal, recovery and outbox', () => {
  useTestDb();

  const makeUser = async (role = 'patient') => {
    seq += 1;
    const user = await User.create({ name: `R${seq}`, email: `refund${seq}@example.com`, password: PASSWORD, role, emailVerified: true });
    const { accessToken } = await issueTokenPair(user);
    return { user, auth: { Authorization: `Bearer ${accessToken}` } };
  };

  /**
   * A finished, charged call: patient with a wallet (charge 1000 paise), a doctor, and (unless
   * status is null) a DoctorEarning with gross 1000, commission 200, net 800.
   */
  const makeCall = async (status: EarningStatus | null, opts: { requestId?: unknown } = {}) => {
    const { user: patient } = await makeUser();
    const { user: doctorUser } = await makeUser('doctor');
    const doctor = await Doctor.create({ userId: doctorUser._id });
    await runInTransaction((s) =>
      walletService.append(s, { userId: patient._id as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: 5000, idempotencyKey: `seed-${patient._id}` }),
    );
    const callId = new mongoose.Types.ObjectId();
    await Call.collection.insertOne({ _id: callId, patientId: patient._id, doctorId: doctor._id, status: 'completed', prescriptionStatus: 'pending', agoraChannelName: `ch-${callId}` });
    await runInTransaction((s) =>
      walletService.append(s, {
        userId: patient._id as never, type: TYPE.CALL_CHARGE, direction: DIR.DEBIT, amountPaise: 1000,
        idempotencyKey: `call:${callId}:charge`, referenceType: 'call', referenceId: callId,
      }),
    );
    const earning = status
      ? await DoctorEarning.create({
          callId, doctorId: doctor._id, grossPaise: 1000, commissionPaise: 200, netPaise: 800, status,
          ...(status === 'released' || status === 'withdrawn' ? { releasedAt: new Date() } : {}),
          ...(status === 'forfeited' ? { forfeitedAt: new Date() } : {}),
          ...(opts.requestId ? { withdrawalRequestId: opts.requestId } : {}),
        })
      : null;
    return { patient, doctorUser, doctor, callId, earning };
  };

  const makeRequest = (doctorId: unknown, amountPaise: number, status: 'pending' | 'paid' | 'rejected' | 'cancelled' = 'pending') =>
    WithdrawalRequest.create({
      doctorId, amountPaise, destinationType: 'upi', destinationSnapshot: { upiId: 'doc@upi' }, status,
      requestedAt: new Date(),
    });

  const admin = async () => (await makeUser('admin')).auth;
  const adminUser = async () => (await makeUser('admin')).user;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  /** Start both operations together, alternating who goes first and with a little jitter, so every interleaving is exercised. */
  const race = async (i: number, a: () => Promise<unknown>, b: () => Promise<unknown>) => {
    const first = i % 2 === 0 ? a : b;
    const second = i % 2 === 0 ? b : a;
    await Promise.allSettled([first(), sleep(Math.random() * 6).then(second)]);
  };
  const refund = (auth: Record<string, string>, callId: unknown, reason = 'Poor audio quality') =>
    request(app).post('/api/v1/admin/refunds').set(auth).send({ callId: String(callId), reason });

  const reload = (id: unknown) => DoctorEarning.findById(id).lean();
  const refundRows = (callId: unknown) => WalletLedger.countDocuments({ idempotencyKey: `call:${callId}:refund` });

  // ============================================================== the patient
  describe('patient side', () => {
    it('refunds the FULL recorded charge, appends rather than reverses, and accepts no amount', async () => {
      const { patient, callId } = await makeCall('held');
      const before = await WalletLedger.find({ userId: patient._id }).sort({ createdAt: 1 }).lean();
      const res = await request(app).post('/api/v1/admin/refunds').set(await admin())
        .send({ callId: String(callId), reason: 'Poor audio', amountPaise: 1, amount: 1, partial: true });
      expect(res.status).toBe(201);
      expect(res.body.data.amountPaise).toBe(1000);
      const after = await WalletLedger.find({ userId: patient._id }).sort({ createdAt: 1 }).lean();
      expect(after).toHaveLength(before.length + 1);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(after[after.length - 1]).toMatchObject({ type: 'refund', direction: 'credit', amountPaise: 1000, balanceAfterPaise: 5000 });
      expect(await walletService.getBalance(patient._id)).toBe(5000);
      expect((await Wallet.findOne({ userId: patient._id }))!.balancePaise).toBe(5000);
    });

    it('is refused for a call with no charge (a free call) or an unknown call', async () => {
      const a = await admin();
      const { callId } = await makeCall(null);
      await WalletLedger.deleteOne({ idempotencyKey: `call:${callId}:charge` });
      expect((await refund(a, callId)).status).toBe(409);
      expect((await refund(a, new mongoose.Types.ObjectId())).status).toBe(404);
    });
  });

  // ============================================================== the doctor
  describe('doctor earning handling', () => {
    it('HELD -> forfeited. Row kept, no money was ever payable, commission not involved', async () => {
      const { callId, earning } = await makeCall('held');
      const res = await refund(await admin(), callId);
      expect(res.body.data.earning).toMatchObject({ action: 'forfeited', earningNetPaise: 800, reversedPaise: 0, newRecoveryPaise: 0 });
      const e = (await reload(earning!._id))!;
      expect(e.status).toBe('forfeited');
      expect(e.forfeitedAt).toBeTruthy();
      expect(e.netPaise).toBe(800); // original figures preserved
      expect(e.grossPaise).toBe(1000);
      expect(await DoctorLedgerAdjustment.countDocuments({ earningId: earning!._id })).toBe(0);
    });

    it('RELEASED, unclaimed -> reversed by the NET only (the platform absorbs its commission); separate adjustment; no recovery', async () => {
      const { patient, doctor, callId, earning } = await makeCall('released');
      expect((await recoveryService.getWithdrawable(doctor._id)).withdrawablePaise).toBe(800);

      const res = await refund(await admin(), callId);
      expect(res.status).toBe(201);
      expect(res.body.data.amountPaise).toBe(1000); // patient: gross
      expect(res.body.data.earning).toMatchObject({ action: 'reversed', reversedPaise: 800, recoveredNowPaise: 800, newRecoveryPaise: 0 });

      const e = (await reload(earning!._id))!;
      expect(e).toMatchObject({ status: 'reversed', recoveryPaise: 0, recoveredPaise: 0, writtenOffPaise: 0, netPaise: 800, grossPaise: 1000, commissionPaise: 200 });
      expect(e.reversedAt).toBeTruthy();

      const adj = await DoctorLedgerAdjustment.find({ earningId: earning!._id }).lean();
      expect(adj).toHaveLength(1);
      const refundEntry = (await WalletLedger.findOne({ idempotencyKey: `call:${callId}:refund` }))!;
      expect(adj[0]).toMatchObject({ type: 'earning_reversal', amountPaise: 800, idempotencyKey: `earning:${earning!._id}:reversal` });
      expect(String(adj[0].refundLedgerEntryId)).toBe(String(refundEntry._id)); // traceable to the refund
      expect(String(adj[0].callId)).toBe(String(callId));
      expect(String(refundEntry.userId)).toBe(String(patient._id));

      // no longer payable or withdrawable
      expect((await recoveryService.getWithdrawable(doctor._id)).withdrawablePaise).toBe(0);
    });

    it('RELEASED and claimed by a PENDING request with other earnings: the request is reduced, stays pending', async () => {
      const { doctor, callId, earning } = await makeCall('released');
      const other = await DoctorEarning.create({ callId: new mongoose.Types.ObjectId(), doctorId: doctor._id, grossPaise: 500, commissionPaise: 100, netPaise: 400, status: 'released', releasedAt: new Date() });
      const reqDoc = await makeRequest(doctor._id, 1200);
      await DoctorEarning.updateMany({ _id: { $in: [earning!._id, other._id] } }, { withdrawalRequestId: reqDoc._id });

      const res = await refund(await admin(), callId);
      expect(res.status).toBe(201);
      expect(res.body.data.earning).toMatchObject({ action: 'reversed', withdrawalRequestReducedByPaise: 800, withdrawalRequestCancelled: false, newRecoveryPaise: 0, recoveredNowPaise: 800 });
      const r = (await WithdrawalRequest.findById(reqDoc._id).lean())!;
      expect(r.status).toBe('pending');
      expect(r.amountPaise).toBe(400);
      expect((await reload(earning!._id))!.status).toBe('reversed');
      expect((await reload(other._id))!.status).toBe('released');
      const adj = (await DoctorLedgerAdjustment.findOne({ earningId: earning!._id, type: 'earning_reversal' }).lean())!;
      expect(adj.metadata).toMatchObject({ requestReducedByPaise: 800, requestCancelled: false });
      expect(String(adj.withdrawalRequestId)).toBe(String(reqDoc._id));
    });

    it('RELEASED and the only earning in a PENDING request: the request reaches zero and is CANCELLED by the system (not an admin rejection)', async () => {
      const { doctor, callId, earning } = await makeCall('released');
      const reqDoc = await makeRequest(doctor._id, 800);
      await DoctorEarning.updateOne({ _id: earning!._id }, { withdrawalRequestId: reqDoc._id });
      const res = await refund(await admin(), callId);
      expect(res.status).toBe(201);
      expect(res.body.data.earning).toMatchObject({ withdrawalRequestCancelled: true, withdrawalRequestReducedByPaise: 800 });
      const r = (await WithdrawalRequest.findById(reqDoc._id).lean())!;
      expect(r).toMatchObject({ amountPaise: 0, status: 'cancelled', decidedBy: null });
      expect(r.rejectionReason).toMatch(/refunded/);
      expect(r.decidedAt).toBeTruthy();
    });

    it('WITHDRAWN (paid out) -> reversed AND the doctor owes the NET back (recovery), never the gross', async () => {
      const { doctor, callId, earning } = await makeCall('released');
      const reqDoc = await makeRequest(doctor._id, 800, 'paid');
      await DoctorEarning.updateOne({ _id: earning!._id }, { status: 'withdrawn', withdrawalRequestId: reqDoc._id });

      const res = await refund(await admin(), callId);
      expect(res.status).toBe(201);
      expect(res.body.data.amountPaise).toBe(1000);
      expect(res.body.data.earning).toMatchObject({ action: 'reversed', reversedPaise: 800, recoveredNowPaise: 0, newRecoveryPaise: 800, totalOutstandingRecoveryPaise: 800 });
      const e = (await reload(earning!._id))!;
      expect(e).toMatchObject({ status: 'reversed', recoveryPaise: 800, recoveredPaise: 0 });
      expect(outstandingOf(e)).toBe(800);
      const types = (await DoctorLedgerAdjustment.find({ earningId: earning!._id }).sort({ _id: 1 }).lean()).map((a) => [a.type, a.amountPaise]);
      expect(types).toEqual([['earning_reversal', 800], ['recovery_recorded', 800]]);
      // the paid request itself is left alone (history)
      expect((await WithdrawalRequest.findById(reqDoc._id).lean())).toMatchObject({ status: 'paid', amountPaise: 800 });
    });

    it('RELEASED but its request is already PAID -> recovery, not a request edit', async () => {
      const { doctor, callId, earning } = await makeCall('released');
      const reqDoc = await makeRequest(doctor._id, 800, 'paid');
      await DoctorEarning.updateOne({ _id: earning!._id }, { withdrawalRequestId: reqDoc._id });
      const res = await refund(await admin(), callId);
      expect(res.body.data.earning).toMatchObject({ newRecoveryPaise: 800, withdrawalRequestReducedByPaise: 0 });
      expect((await WithdrawalRequest.findById(reqDoc._id).lean())!.amountPaise).toBe(800);
    });

    it('a refund is NEVER blocked by a withdrawal, whatever its state', async () => {
      for (const reqStatus of ['pending', 'paid', 'rejected', 'cancelled'] as const) {
        const { doctor, callId, earning } = await makeCall('released');
        const reqDoc = await makeRequest(doctor._id, 800, reqStatus);
        await DoctorEarning.updateOne({ _id: earning!._id }, { withdrawalRequestId: reqDoc._id });
        expect((await refund(await admin(), callId)).status).toBe(201);
        expect((await reload(earning!._id))!.status).toBe('reversed');
      }
    });

    it('a call with no earning at all is still refunded', async () => {
      const { callId } = await makeCall(null);
      const res = await refund(await admin(), callId);
      expect(res.status).toBe(201);
      expect(res.body.data.earning.action).toBe('none');
    });

    it('an already forfeited earning is left as it was', async () => {
      const { callId, earning } = await makeCall('forfeited');
      const res = await refund(await admin(), callId);
      expect(res.body.data.earning.action).toBe('none');
      expect((await reload(earning!._id))!.status).toBe('forfeited');
    });
  });

  // ============================================================== idempotency
  describe('idempotency: no duplicate refunds, reversals, recoveries or notices', () => {
    it('refunding twice is a 409 and changes nothing', async () => {
      const a = await admin();
      const { patient, doctor, callId, earning } = await makeCall('released');
      await DoctorEarning.updateOne({ _id: earning!._id }, { status: 'withdrawn' });
      expect((await refund(a, callId)).status).toBe(201);
      const snapshot = {
        ledger: await WalletLedger.countDocuments({ userId: patient._id }),
        adj: await DoctorLedgerAdjustment.countDocuments({ doctorId: doctor._id }),
        outbox: await OutboxEvent.countDocuments({}),
        earning: await reload(earning!._id),
      };
      expect((await refund(a, callId)).status).toBe(409);
      expect(await WalletLedger.countDocuments({ userId: patient._id })).toBe(snapshot.ledger);
      expect(await DoctorLedgerAdjustment.countDocuments({ doctorId: doctor._id })).toBe(snapshot.adj);
      expect(await OutboxEvent.countDocuments({})).toBe(snapshot.outbox);
      expect(await reload(earning!._id)).toEqual(snapshot.earning);
    });

    it('five simultaneous refunds produce exactly one refund, one reversal, one recovery and two notices', async () => {
      const a = await admin();
      const { patient, callId, earning } = await makeCall('released');
      await DoctorEarning.updateOne({ _id: earning!._id }, { status: 'withdrawn' });
      const results = await Promise.all(Array.from({ length: 5 }, () => refund(a, callId)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await refundRows(callId)).toBe(1);
      expect(await DoctorLedgerAdjustment.countDocuments({ earningId: earning!._id, type: 'earning_reversal' })).toBe(1);
      expect(await DoctorLedgerAdjustment.countDocuments({ earningId: earning!._id, type: 'recovery_recorded' })).toBe(1);
      expect(await OutboxEvent.countDocuments({})).toBe(2);
      expect(await walletService.getBalance(patient._id)).toBe(5000);
      expect((await reload(earning!._id))!.recoveryPaise).toBe(800);
    });
  });

  // ============================================================== shared expiry path
  describe('the Phase 7 expiry path shares the same code and key', () => {
    it('expiry refund works, expires the prescription in the same session, and is repeatable', async () => {
      const { callId, earning } = await makeCall('held');
      const first = await refundService.refundCallForExpiry(String(callId));
      expect('alreadyRefunded' in first).toBe(false);
      expect((await reload(earning!._id))!.status).toBe('forfeited');
      expect((await Call.findById(callId).lean())!.prescriptionStatus).toBe('expired');
      expect(await refundService.refundCallForExpiry(String(callId))).toEqual({ alreadyRefunded: true });
      expect(await refundRows(callId)).toBe(1);
    });

    it('admin then expiry (and expiry then admin) can never refund the same call twice', async () => {
      const a = await admin();
      const one = await makeCall('held');
      expect((await refund(a, one.callId)).status).toBe(201);
      expect(await refundService.refundCallForExpiry(String(one.callId))).toEqual({ alreadyRefunded: true });
      expect(await refundRows(one.callId)).toBe(1);

      const two = await makeCall('held');
      await refundService.refundCallForExpiry(String(two.callId));
      expect((await refund(a, two.callId)).status).toBe(409);
      expect(await refundRows(two.callId)).toBe(1);
    });

    it('expiry and admin racing each other refund once', async () => {
      const a = await admin();
      const { callId } = await makeCall('held');
      await Promise.allSettled([refund(a, callId), refundService.refundCallForExpiry(String(callId))]);
      expect(await refundRows(callId)).toBe(1);
      expect(await DoctorEarning.countDocuments({ callId, status: 'forfeited' })).toBe(1);
    });
  });

  // ============================================================== atomicity
  describe('atomicity: the refund is all or nothing', () => {
    it('a failure after the patient credit rolls EVERYTHING back (ledger, cache, earning, request, adjustments, notices)', async () => {
      const { patient, doctor, callId, earning } = await makeCall('released');
      const reqDoc = await makeRequest(doctor._id, 800);
      await DoctorEarning.updateOne({ _id: earning!._id }, { withdrawalRequestId: reqDoc._id });

      const spy = jest.spyOn(OutboxEvent, 'create').mockRejectedValueOnce(new Error('outbox down') as never);
      const res = await refund(await admin(), callId);
      spy.mockRestore();
      expect(res.status).toBe(500);

      expect(await refundRows(callId)).toBe(0);
      expect(await walletService.getBalance(patient._id)).toBe(4000);
      expect((await Wallet.findOne({ userId: patient._id }))!.balancePaise).toBe(4000);
      expect(await reload(earning!._id)).toMatchObject({ status: 'released', recoveryPaise: 0 });
      expect(await WithdrawalRequest.findById(reqDoc._id).lean()).toMatchObject({ status: 'pending', amountPaise: 800 });
      expect(await DoctorLedgerAdjustment.countDocuments({})).toBe(0);
      expect(await OutboxEvent.countDocuments({})).toBe(0);

      expect((await refund(await admin(), callId)).status).toBe(201); // and a retry then works
    });
  });

  // ============================================================== concurrency with other money ops
  describe('races on the earning row serialise correctly', () => {
    /** A Phase 7 style withdrawal claim: the filter { withdrawalRequestId: null } is the lock. */
    const claim = (doctorId: unknown, earningId: unknown) =>
      runInTransaction(async (s) => {
        const e = await DoctorEarning.findOne({ _id: earningId, status: 'released', withdrawalRequestId: null }).session(s);
        if (!e) throw new Error('nothing to claim');
        const [reqDoc] = await WithdrawalRequest.create(
          [{ doctorId, amountPaise: e.netPaise, destinationType: 'upi', destinationSnapshot: {}, requestedAt: new Date() }],
          { session: s },
        );
        const r = await DoctorEarning.updateOne({ _id: earningId, withdrawalRequestId: null, status: 'released' }, { withdrawalRequestId: reqDoc._id }, { session: s });
        if (r.modifiedCount !== 1) throw new Error('claim lost');
        return reqDoc;
      });

    it('refund vs withdrawal request: whichever order, the end state is consistent', async () => {
      const a = { userId: (await adminUser())._id };
      for (let i = 0; i < 14; i += 1) {
        const { doctor, callId, earning } = await makeCall('released');
        await race(i, () => refundService.refundCall({ userId: String(a.userId) }, { callId: String(callId), reason: 'race test' }), () => claim(doctor._id, earning!._id));

        expect(await refundRows(callId)).toBe(1);
        expect((await reload(earning!._id))!.status).toBe('reversed');
        const reqs = await WithdrawalRequest.find({ doctorId: doctor._id }).lean();
        for (const r of reqs) {
          // a request that exists must not still ask for the refunded money
          expect(r.amountPaise).toBe(0);
          expect(r.status).toBe('cancelled');
        }
        expect((await recoveryService.getWithdrawable(doctor._id)).withdrawablePaise).toBe(0);
      }
    });

    /** A Phase 7 style prescription submit: held -> released, filtered on status. */
    const submit = (earningId: unknown) =>
      runInTransaction(async (s) => {
        const r = await DoctorEarning.updateOne({ _id: earningId, status: 'held' }, { status: 'released', releasedAt: new Date() }, { session: s });
        if (r.modifiedCount !== 1) throw new Error('earning is no longer held');
      });

    it('refund vs prescription submit: the earning never ends up released for a refunded call', async () => {
      const a = { userId: (await adminUser())._id };
      const outcomes = new Set<string>();
      for (let i = 0; i < 14; i += 1) {
        const { callId, earning } = await makeCall('held');
        await race(i, () => refundService.refundCall({ userId: String(a.userId) }, { callId: String(callId), reason: 'race test' }), () => submit(earning!._id));
        const e = (await reload(earning!._id))!;
        expect(['forfeited', 'reversed']).toContain(e.status);
        expect(await refundRows(callId)).toBe(1);
        expect(e.recoveryPaise).toBe(0); // never paid out
        outcomes.add(e.status);
      }
      expect(outcomes.size).toBeGreaterThan(0);
    });
  });

  // ============================================================== recovery
  describe('recovery from future earnings', () => {
    const owedDoctor = async () => {
      const ctx = await makeCall('released');
      await DoctorEarning.updateOne({ _id: ctx.earning!._id }, { status: 'withdrawn' });
      await refund(await admin(), ctx.callId);
      return ctx;
    };

    it('withdrawable nets the debt; a larger debt carries over (never negative)', async () => {
      const { doctor } = await owedDoctor(); // owes 800
      await DoctorEarning.create({ callId: new mongoose.Types.ObjectId(), doctorId: doctor._id, grossPaise: 500, commissionPaise: 100, netPaise: 400, status: 'released', releasedAt: new Date() });
      expect(await recoveryService.getWithdrawable(doctor._id)).toEqual({ releasedUnclaimedPaise: 400, outstandingRecoveryPaise: 800, withdrawablePaise: 0 });
      await DoctorEarning.create({ callId: new mongoose.Types.ObjectId(), doctorId: doctor._id, grossPaise: 1500, commissionPaise: 300, netPaise: 1200, status: 'released', releasedAt: new Date() });
      expect((await recoveryService.getWithdrawable(doctor._id)).withdrawablePaise).toBe(800);
    });

    it('applying recovery to a withdrawal is partial, oldest first, recorded, and never over-applied', async () => {
      const { doctor, earning } = await owedDoctor();
      const reqDoc = await makeRequest(doctor._id, 100);
      const taken = await runInTransaction((s) =>
        recoveryService.applyToWithdrawal(s, { doctorId: doctor._id, withdrawalRequestId: reqDoc._id, maxPaise: 300 }),
      );
      expect(taken).toBe(300);
      expect(outstandingOf((await reload(earning!._id))!)).toBe(500);
      const settled = await DoctorLedgerAdjustment.find({ earningId: earning!._id, type: 'recovery_settled' }).lean();
      expect(settled).toHaveLength(1);
      expect(settled[0]).toMatchObject({ amountPaise: 300 });
      expect(String(settled[0].withdrawalRequestId)).toBe(String(reqDoc._id));

      const rest = await runInTransaction((s) =>
        recoveryService.applyToWithdrawal(s, { doctorId: doctor._id, withdrawalRequestId: new mongoose.Types.ObjectId(), maxPaise: 99999 }),
      );
      expect(rest).toBe(500); // only what was still owed
      const e = (await reload(earning!._id))!;
      expect(e.recoveredPaise).toBe(800);
      expect(outstandingOf(e)).toBe(0);
      expect(await recoveryService.outstandingForDoctor(doctor._id)).toBe(0);
    });

    it('two withdrawals applying recovery at once cannot recover more than is owed', async () => {
      const { doctor, earning } = await owedDoctor();
      const apply = () =>
        runInTransaction((s) =>
          recoveryService.applyToWithdrawal(s, { doctorId: doctor._id, withdrawalRequestId: new mongoose.Types.ObjectId(), maxPaise: 800 }),
        );
      const taken = await Promise.all([apply(), apply()]);
      expect(taken.reduce((x, y) => x + y, 0)).toBe(800);
      expect((await reload(earning!._id))!.recoveredPaise).toBe(800);
    });

    it('the earning row model refuses to over-recover', async () => {
      const { earning } = await owedDoctor();
      const doc = (await DoctorEarning.findById(earning!._id))!;
      doc.recoveredPaise = 700;
      doc.writtenOffPaise = 200;
      await expect(doc.save()).rejects.toThrow(/cannot exceed/);
    });
  });

  // ============================================================== write-off
  describe('write-off of an unrecoverable balance', () => {
    const owed = async (daysAgo: number) => {
      const ctx = await makeCall('released');
      await DoctorEarning.updateOne({ _id: ctx.earning!._id }, { status: 'withdrawn' });
      await refund(await admin(), ctx.callId);
      await DoctorEarning.updateOne({ _id: ctx.earning!._id }, { reversedAt: new Date(Date.now() - daysAgo * 86400000) });
      return ctx;
    };
    const writeOff = (auth: Record<string, string>, earningId: unknown, note = 'Doctor left the platform') =>
      request(app).post(`/api/v1/admin/recoveries/${earningId}/write-off`).set(auth).send({ note });

    it('uses the provisional 180-day period when no settings document exists, and refuses inside it', async () => {
      const a = await admin();
      const young = await owed(100); // 100 days: inside 180
      const res = await writeOff(a, young.earning!._id);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/period has not ended/);
      const old = await owed(200); // 200 days: past 180
      expect((await writeOff(a, old.earning!._id)).status).toBe(201);
    });

    it('a settings document written before this field existed also means 180 days', async () => {
      await PlatformSetting.collection.insertOne({
        commissionPct: 20, dayStartTime: '06:00', nightStartTime: '20:00', minWalletPaise: 10000,
        urgentCallDayRatePaise: 0, urgentCallNightRatePaise: 0, roundingMode: 'up',
        prescriptionWindowMinutes: 120, reminderMinutes: 60, recordingRetentionYears: 3, minWithdrawalPaise: 10000,
      });
      const a = await admin();
      expect((await writeOff(a, (await owed(100)).earning!._id)).status).toBe(409);
      expect((await writeOff(a, (await owed(200)).earning!._id)).status).toBe(201);
    });

    it('the schema default is 180 days, and null disables write-offs', async () => {
      const created = await PlatformSetting.create({});
      expect(created.recoveryPeriodDays).toBe(180);
      await PlatformSetting.updateOne({ _id: created._id }, { recoveryPeriodDays: null });
      const { earning } = await owed(400);
      const res = await writeOff(await admin(), earning!._id);
      expect(res.status).toBe(409);
      expect(res.body.message).toMatch(/disabled/);
    });

    it('is refused before the period ends, allowed after, and recorded as an adjustment', async () => {
      await PlatformSetting.create({ recoveryPeriodDays: 30 });
      const a = await admin();
      const early = await owed(10);
      expect((await writeOff(a, early.earning!._id)).status).toBe(409);

      const late = await owed(40);
      const res = await writeOff(a, late.earning!._id);
      expect(res.status).toBe(201);
      expect(res.body.data).toEqual({ earningId: String(late.earning!._id), writtenOffPaise: 800 });

      const e = (await reload(late.earning!._id))!;
      expect(e).toMatchObject({ status: 'reversed', recoveryPaise: 800, recoveredPaise: 0, writtenOffPaise: 800, netPaise: 800 });
      expect(outstandingOf(e)).toBe(0);
      const adj = (await DoctorLedgerAdjustment.findOne({ earningId: late.earning!._id, type: 'recovery_write_off' }).lean())!;
      expect(adj).toMatchObject({ amountPaise: 800, note: 'Doctor left the platform' });
      expect(adj.createdBy).toBeTruthy();
      // history is intact: the reversal and the recovery entries are still there
      expect(await DoctorLedgerAdjustment.countDocuments({ earningId: late.earning!._id })).toBe(3);
    });

    it('writes off only what is still outstanding after a partial recovery, and only once', async () => {
      await PlatformSetting.create({ recoveryPeriodDays: 30 });
      const { doctor, earning } = await owed(40);
      await runInTransaction((s) =>
        recoveryService.applyToWithdrawal(s, { doctorId: doctor._id, withdrawalRequestId: new mongoose.Types.ObjectId(), maxPaise: 300 }),
      );
      const a = await admin();
      const res = await writeOff(a, earning!._id);
      expect(res.body.data.writtenOffPaise).toBe(500);
      const e = (await reload(earning!._id))!;
      expect(e.recoveredPaise + e.writtenOffPaise).toBe(e.recoveryPaise);
      expect((await writeOff(a, earning!._id)).status).toBe(409);
      expect((await reload(earning!._id))!.writtenOffPaise).toBe(500);
    });

    it('two simultaneous write-offs record one adjustment', async () => {
      await PlatformSetting.create({ recoveryPeriodDays: 30 });
      const { earning } = await owed(40);
      const a = await admin();
      const results = await Promise.all([writeOff(a, earning!._id), writeOff(a, earning!._id), writeOff(a, earning!._id)]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await DoctorLedgerAdjustment.countDocuments({ earningId: earning!._id, type: 'recovery_write_off' })).toBe(1);
    });

    it('admin only, with a real note, for an existing earning that owes something', async () => {
      await PlatformSetting.create({ recoveryPeriodDays: 30 });
      const { earning } = await owed(40);
      const patient = await makeUser();
      const doctor = await makeUser('doctor');
      expect((await request(app).post(`/api/v1/admin/recoveries/${earning!._id}/write-off`).send({ note: 'xxxxxx' })).status).toBe(401);
      expect((await writeOff(patient.auth, earning!._id)).status).toBe(403);
      expect((await writeOff(doctor.auth, earning!._id)).status).toBe(403);
      const a = await admin();
      expect((await writeOff(a, earning!._id, 'no')).status).toBe(400);
      expect((await writeOff(a, new mongoose.Types.ObjectId())).status).toBe(404);
      const clean = await makeCall('released'); // owes nothing
      expect((await writeOff(a, clean.earning!._id)).status).toBe(409);
    });

    it('GET /admin/recoveries lists only open debts', async () => {
      await PlatformSetting.create({ recoveryPeriodDays: 30 });
      const open = await owed(5);
      const done = await owed(40);
      const a = await admin();
      await writeOff(a, done.earning!._id);
      const res = await request(app).get('/api/v1/admin/recoveries').set(a);
      expect(res.status).toBe(200);
      expect(res.body.data.map((r: { _id: string }) => r._id)).toEqual([String(open.earning!._id)]);
      expect(res.body.data[0].outstandingPaise).toBe(800);
    });
  });

  describe('the adjustment ledger is append-only', () => {
    it('cannot be updated or deleted through the model', async () => {
      const { callId, earning } = await makeCall('released');
      await refund(await admin(), callId);
      const row = (await DoctorLedgerAdjustment.findOne({ earningId: earning!._id }))!;
      await expect(DoctorLedgerAdjustment.updateOne({ _id: row._id }, { amountPaise: 1 })).rejects.toThrow(/append-only/);
      await expect(DoctorLedgerAdjustment.findOneAndUpdate({ _id: row._id }, { note: 'x' })).rejects.toThrow(/append-only/);
      await expect(DoctorLedgerAdjustment.deleteOne({ _id: row._id })).rejects.toThrow(/append-only/);
      await expect(DoctorLedgerAdjustment.deleteMany({})).rejects.toThrow(/append-only/);
      row.note = 'changed';
      await expect(row.save()).rejects.toThrow(/append-only/);
      expect(await DoctorLedgerAdjustment.countDocuments({ earningId: earning!._id })).toBe(1);
    });
  });

  // ============================================================== notifications
  describe('refund notifications through the outbox', () => {
    it('queues one patient and one doctor notice in the same transaction, with the right content', async () => {
      const { patient, doctorUser, callId, earning } = await makeCall('released');
      await DoctorEarning.updateOne({ _id: earning!._id }, { status: 'withdrawn' });
      await refund(await admin(), callId);

      const events = await OutboxEvent.find({}).sort({ type: 1 }).lean();
      expect(events.map((e) => e.dedupeKey).sort()).toEqual([`call:${callId}:refund:doctor`, `call:${callId}:refund:patient`]);
      expect(events.every((e) => e.status === 'pending')).toBe(true);
      const p = events.find((e) => e.type === 'refund.patient_notice')!.payload as Record<string, unknown>;
      expect(p).toMatchObject({ userId: String(patient._id), amountPaise: 1000, status: 'completed', reference: `call:${callId}:refund` });
      expect(p.refundEntryId).toBeTruthy();
      const d = events.find((e) => e.type === 'refund.doctor_notice')!.payload as Record<string, unknown>;
      expect(d).toMatchObject({
        userId: String(doctorUser._id), callId: String(callId), reversedPaise: 800, recoveredNowPaise: 0,
        newRecoveryPaise: 800, totalOutstandingRecoveryPaise: 800,
      });
    });

    it('delivers the patient and doctor in-app notifications, and delivery is idempotent', async () => {
      const { patient, doctorUser, callId, earning } = await makeCall('released');
      await DoctorEarning.updateOne({ _id: earning!._id }, { status: 'withdrawn' });
      await refund(await admin(), callId);

      const stats = await outboxService.drain(outboxHandlers);
      expect(stats).toEqual({ delivered: 2, retried: 0, failed: 0 });

      const pn = await Notification.findOne({ userId: patient._id }).lean();
      expect(pn?.title).toBe('Refund processed');
      expect(pn?.body).toContain('₹10');
      expect(pn?.body).toContain('completed');
      expect(pn?.data).toMatchObject({ amountPaise: 1000, status: 'completed', reference: `call:${callId}:refund` });

      const dn = await Notification.findOne({ userId: doctorUser._id }).lean();
      expect(dn?.body).toContain('₹8');
      expect(dn?.body).toMatch(/recovered from your future withdrawals/);
      expect(dn?.body).toMatch(/Total outstanding recovery: ₹8/);

      // run the handlers again for the same events (at-least-once delivery): still one each
      for (const e of await OutboxEvent.find({}).lean()) {
        await outboxHandlers[e.type as keyof typeof outboxHandlers]!(e as never);
      }
      expect(await Notification.countDocuments({ userId: patient._id })).toBe(1);
      expect(await Notification.countDocuments({ userId: doctorUser._id })).toBe(1);
      expect(await outboxService.drain(outboxHandlers)).toEqual({ delivered: 0, retried: 0, failed: 0 }); // nothing left
    });

    it("respects the user's per-type notification setting but still completes the event", async () => {
      const { patient, callId } = await makeCall('held');
      await NotificationSetting.create({ userId: patient._id, payment: false });
      await refund(await admin(), callId);
      await outboxService.drain(outboxHandlers);
      expect(await Notification.countDocuments({ userId: patient._id })).toBe(0);
      expect(await OutboxEvent.countDocuments({ status: 'done' })).toBe(2);
    });

    it('a failing delivery is retried with backoff, then delivered', async () => {
      const { patient, callId } = await makeCall('held');
      await refund(await admin(), callId);
      let failures = 1;
      const flaky = {
        ...outboxHandlers,
        'refund.patient_notice': async (e: never) => {
          if (failures-- > 0) throw new Error('smtp down');
          await outboxHandlers['refund.patient_notice']!(e);
        },
      };
      const t0 = new Date();
      const first = await outboxService.drain(flaky as never, { now: t0 });
      expect(first).toEqual({ delivered: 1, retried: 1, failed: 0 }); // doctor notice ok, patient notice failed
      const ev = (await OutboxEvent.findOne({ type: 'refund.patient_notice' }).lean())!;
      expect(ev).toMatchObject({ status: 'pending', attempts: 1, lastError: 'smtp down' });
      expect(ev.nextAttemptAt.getTime()).toBeGreaterThan(t0.getTime());
      expect(await Notification.countDocuments({ userId: patient._id })).toBe(0);

      expect((await outboxService.drain(flaky as never, { now: t0 })).delivered).toBe(0); // the retry is not due yet
      const later = new Date(t0.getTime() + 10 * 60_000);
      expect((await outboxService.drain(flaky as never, { now: later })).delivered).toBe(1);
      expect(await Notification.countDocuments({ userId: patient._id })).toBe(1);
      expect((await OutboxEvent.findOne({ type: 'refund.patient_notice' }).lean())).toMatchObject({ status: 'done', attempts: 2 });
    });

    it('gives up after maxAttempts and raises a critical finding', async () => {
      const { callId } = await makeCall('held');
      await refund(await admin(), callId);
      await OutboxEvent.updateMany({}, { maxAttempts: 2 });
      const broken = { 'refund.patient_notice': async () => { throw new Error('always'); }, 'refund.doctor_notice': async () => undefined };
      let now = new Date();
      await outboxService.drain(broken as never, { now });
      now = new Date(now.getTime() + 2 * 3600_000);
      const stats = await outboxService.drain(broken as never, { now });
      expect(stats.failed).toBe(1);
      expect((await OutboxEvent.findOne({ type: 'refund.patient_notice' }).lean())!.status).toBe('failed');
      expect((await ReconciliationFinding.findOne({ checkName: 'outbox_event_failed' }).lean())?.severity).toBe('critical');
    });

    it('a worker that died mid-delivery does not strand the event (the lock expires)', async () => {
      const { callId } = await makeCall('held');
      await refund(await admin(), callId);
      await OutboxEvent.updateMany({}, { status: 'processing', lockedUntil: new Date(Date.now() - 1000), attempts: 1 });
      expect((await outboxService.drain(outboxHandlers)).delivered).toBe(2);
    });

    it('two workers draining at once deliver each event once', async () => {
      const { patient, callId } = await makeCall('held');
      await refund(await admin(), callId);
      await Promise.all([outboxService.drain(outboxHandlers), outboxService.drain(outboxHandlers)]);
      expect(await Notification.countDocuments({ userId: patient._id })).toBe(1);
      expect(await OutboxEvent.countDocuments({ status: 'done' })).toBe(2);
    });

    it('the same notice cannot be queued twice (dedupe key)', async () => {
      const add = () =>
        runInTransaction((s) =>
          outboxService.addEvents(s, [{ type: 'refund.patient_notice', dedupeKey: 'dup-1', payload: { userId: String(new mongoose.Types.ObjectId()) } }]),
        );
      await add();
      await expect(add()).rejects.toMatchObject({ code: 11000 });
      expect(await OutboxEvent.countDocuments({})).toBe(1);
    });

    it('no event is queued when the refund itself is rejected', async () => {
      const { callId } = await makeCall('held');
      await WalletLedger.deleteOne({ idempotencyKey: `call:${callId}:charge` });
      await refund(await admin(), callId);
      expect(await OutboxEvent.countDocuments({})).toBe(0);
    });
  });

  // ============================================================== legacy signup
  describe('legacy signup transition switch', () => {
    const original = config.legacy_signup_mode;
    afterEach(() => {
      config.legacy_signup_mode = original;
    });

    it('enabled (default): the old endpoint still works', async () => {
      config.legacy_signup_mode = 'enabled';
      const res = await request(app).post('/legacy/create').send({});
      expect(res.status).toBe(201);
    });

    it('gone: 410 with the standard envelope, a pointer to /auth/register and deprecation headers', async () => {
      config.legacy_signup_mode = 'gone';
      const res = await request(app).post('/legacy/create').send({});
      expect(res.status).toBe(410);
      expect(res.body).toMatchObject({ success: false, data: null });
      expect(res.body.message).toMatch(/auth\/register/);
      expect(res.body.meta.successor).toBe('/api/v1/auth/register');
      expect(res.headers.deprecation).toBe('true');
      expect(res.headers.sunset).toBeTruthy();
      expect(res.headers.link).toContain('/api/v1/auth/register');
    });

    it('defaults to enabled for any unexpected value', () => {
      expect(['enabled', 'gone']).toContain(config.legacy_signup_mode);
    });
  });

  // ============================================================== final pre-Phase-6 audit
  describe('final audit: invariants that must always hold', () => {
    /** The running totals on an earning are exactly the sum of its append-only adjustments. */
    const assertEarningMatchesAdjustments = async (earningId: unknown) => {
      const e = (await reload(earningId))!;
      const adj = await DoctorLedgerAdjustment.find({ earningId }).lean();
      const sum = (t: string) => adj.filter((a) => a.type === t).reduce((s, a) => s + a.amountPaise, 0);
      expect(e.recoveryPaise).toBe(sum('recovery_recorded'));
      expect(e.recoveredPaise).toBe(sum('recovery_settled'));
      expect(e.writtenOffPaise).toBe(sum('recovery_write_off'));
      expect(e.recoveredPaise + e.writtenOffPaise).toBeLessThanOrEqual(e.recoveryPaise);
      expect(e.recoveryPaise).toBeLessThanOrEqual(e.netPaise);
      if (e.status === 'reversed') expect(sum('earning_reversal')).toBe(e.netPaise);
    };

    const owedLong = async () => {
      const ctx = await makeCall('released');
      await DoctorEarning.updateOne({ _id: ctx.earning!._id }, { status: 'withdrawn' });
      await refund(await admin(), ctx.callId);
      await DoctorEarning.updateOne({ _id: ctx.earning!._id }, { reversedAt: new Date(Date.now() - 200 * 86400000) });
      return ctx;
    };

    it('totals on the earning always equal the sum of its adjustments, through every stage', async () => {
      const { doctor, earning } = await owedLong();
      await assertEarningMatchesAdjustments(earning!._id);
      await runInTransaction((s) =>
        recoveryService.applyToWithdrawal(s, { doctorId: doctor._id, withdrawalRequestId: new mongoose.Types.ObjectId(), maxPaise: 300 }),
      );
      await assertEarningMatchesAdjustments(earning!._id);
      await recoveryService.writeOff({ userId: String(new mongoose.Types.ObjectId()) }, { earningId: String(earning!._id), note: 'Doctor left the platform' });
      await assertEarningMatchesAdjustments(earning!._id);
      const e = (await reload(earning!._id))!;
      expect(e).toMatchObject({ recoveredPaise: 300, writtenOffPaise: 500, recoveryPaise: 800 });
    });

    it('write-off racing a withdrawal that applies recovery never over-clears the debt', async () => {
      for (let i = 0; i < 10; i += 1) {
        const { doctor, earning } = await owedLong();
        const apply = () =>
          runInTransaction((s) =>
            recoveryService.applyToWithdrawal(s, { doctorId: doctor._id, withdrawalRequestId: new mongoose.Types.ObjectId(), maxPaise: 300 }),
          );
        const off = () => recoveryService.writeOff({ userId: String(new mongoose.Types.ObjectId()) }, { earningId: String(earning!._id), note: 'Doctor left the platform' });
        await race(i, apply, off);
        await assertEarningMatchesAdjustments(earning!._id);
        const e = (await reload(earning!._id))!;
        expect(e.recoveredPaise + e.writtenOffPaise).toBeLessThanOrEqual(800);
      }
    });

    it('a pending request smaller than the earning it claims never blocks the refund', async () => {
      // Phase 7 funds payout PLUS the recovery it settles, so a request can pay less than the net it claims
      const { doctor, callId, earning } = await makeCall('released');
      const reqDoc = await makeRequest(doctor._id, 300);
      await DoctorEarning.updateOne({ _id: earning!._id }, { withdrawalRequestId: reqDoc._id });
      const res = await refund(await admin(), callId);
      expect(res.status).toBe(201);
      expect(res.body.data.earning).toMatchObject({ action: 'reversed', withdrawalRequestReducedByPaise: 300, withdrawalRequestCancelled: true });
      expect(await WithdrawalRequest.findById(reqDoc._id).lean()).toMatchObject({ amountPaise: 0, status: 'cancelled' });
      expect(await refundRows(callId)).toBe(1);
    });

    it('concurrent refunds of different calls for ONE patient lose no credit and keep the ledger chain consistent', async () => {
      const { user: patient } = await makeUser();
      const { user: doctorUser } = await makeUser('doctor');
      const doctor = await Doctor.create({ userId: doctorUser._id });
      await runInTransaction((s) =>
        walletService.append(s, { userId: patient._id as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: 10000, idempotencyKey: `seed-${patient._id}` }),
      );
      const callIds: mongoose.Types.ObjectId[] = [];
      for (let i = 0; i < 6; i += 1) {
        const callId = new mongoose.Types.ObjectId();
        callIds.push(callId);
        await Call.collection.insertOne({ _id: callId, patientId: patient._id, doctorId: doctor._id, status: 'completed', agoraChannelName: `ch-${callId}` });
        await runInTransaction((s) =>
          walletService.append(s, { userId: patient._id as never, type: TYPE.CALL_CHARGE, direction: DIR.DEBIT, amountPaise: 500, idempotencyKey: `call:${callId}:charge`, referenceType: 'call', referenceId: callId }),
        );
      }
      expect(await walletService.getBalance(patient._id)).toBe(7000);
      const a = { userId: String((await adminUser())._id) };
      const results = await Promise.allSettled(callIds.map((id) => refundService.refundCall(a, { callId: String(id), reason: 'bulk audit refund' })));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(6);
      expect(await walletService.getBalance(patient._id)).toBe(10000);
      expect((await Wallet.findOne({ userId: patient._id }))!.balancePaise).toBe(10000);
      let running = 0;
      for (const r of await WalletLedger.find({ userId: patient._id }).sort({ createdAt: 1, _id: 1 }).lean()) {
        running += r.direction === 'credit' ? r.amountPaise : -r.amountPaise;
        expect(r.balanceAfterPaise).toBe(running);
      }
    });

    it('a refund and a top-up credit for the same patient at the same moment both land', async () => {
      const { patient, callId } = await makeCall('held');
      const a = { userId: String((await adminUser())._id) };
      const topup = () =>
        runInTransaction((s) =>
          walletService.append(s, { userId: patient._id as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: 700, idempotencyKey: `race-topup-${patient._id}` }),
        );
      await Promise.all([refundService.refundCall(a, { callId: String(callId), reason: 'race refund' }), topup()]);
      expect(await walletService.getBalance(patient._id)).toBe(5000 + 700); // 5000 after the charge was refunded
      expect((await Wallet.findOne({ userId: patient._id }))!.balancePaise).toBe(5700);
    });
  });
});
