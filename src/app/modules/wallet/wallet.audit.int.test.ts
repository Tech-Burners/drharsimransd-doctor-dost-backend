// Production-readiness audit tests (Phase 4/5). Real replica set; the REAL express app from
// src/app.ts for the HTTP-level checks, so middleware order (raw body before JSON) is the
// production order, not a test copy of it.
import { createHmac } from 'crypto';
import mongoose from 'mongoose';
import request from 'supertest';
import app from '../../../app';
import { useTestDb } from '../../../test/helpers/db';
import config from '../../config';
import { setPaymentGateway, PaymentGateway } from '../../../shared/razorpay';
import { FakeRedis } from '../../../test/helpers/fakeRedis';
import { setRateLimitStore } from '../../../shared/rateLimit';
import { runInTransaction } from '../../../shared/transaction';
import { issueTokenPair } from '../auth/auth.tokens';
import { User } from '../user/user.model';
import { Wallet } from './wallet.model';
import { WalletLedger } from './walletLedger.model';
import { walletService } from './wallet.service';
import { PaymentOrder } from '../payment/paymentOrder.model';
import { ReconciliationFinding } from '../reconciliationFinding/reconciliationFinding.model';
import { Call } from '../call/call.model';
import { WALLET_LEDGER_DIRECTION as DIR, WALLET_LEDGER_TYPE as TYPE } from './walletLedger.constants';

const SECRET = 'whsec_audit';
const sign = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
let seq = 0;

class FakeGateway implements PaymentGateway {
  n = 0;
  async createOrder(input: { amountPaise: number }) {
    this.n += 1;
    return { id: `order_audit_${this.n}_${Math.random().toString(36).slice(2, 7)}`, amountPaise: input.amountPaise, currency: 'INR' };
  }
}

/** The ledger is internally consistent: every row's balance follows from the one before it. */
const assertChain = async (userId: unknown) => {
  const rows = await WalletLedger.find({ userId }).sort({ createdAt: 1, _id: 1 }).lean();
  let running = 0;
  for (const r of rows) {
    running += r.direction === 'credit' ? r.amountPaise : -r.amountPaise;
    expect(running).toBeGreaterThanOrEqual(0);
    expect(r.balanceAfterPaise).toBe(running);
  }
  const wallet = await Wallet.findOne({ userId }).lean();
  expect(wallet?.balancePaise ?? 0).toBe(running);
  expect(await walletService.getBalance(userId as string)).toBe(running);
  return rows;
};

describe('Phase 4/5 audit', () => {
  useTestDb();
  const original = { secret: config.razorpay.webhookSecret, key: config.razorpay.keyId };

  beforeEach(() => {
    setPaymentGateway(new FakeGateway());
    setRateLimitStore(new FakeRedis());
    config.razorpay.webhookSecret = SECRET;
    config.razorpay.keyId = 'rzp_test_public';
  });
  afterAll(() => {
    setPaymentGateway(null);
    setRateLimitStore(null);
    config.razorpay.webhookSecret = original.secret;
    config.razorpay.keyId = original.key;
  });

  const makeUser = async (role = 'patient') => {
    seq += 1;
    const user = await User.create({ name: `A${seq}`, email: `audit${seq}@example.com`, password: 'Str0ng-Passw0rd', role, emailVerified: true });
    const { accessToken } = await issueTokenPair(user);
    return { user, auth: { Authorization: `Bearer ${accessToken}` } };
  };
  const post = (raw: string, signature?: string) => {
    const r = request(app).post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json');
    if (signature !== undefined) r.set('X-Razorpay-Signature', signature);
    return r.send(raw);
  };
  const captured = (orderId: string, paymentId: string, amount: number) =>
    JSON.stringify({ event: 'payment.captured', payload: { payment: { entity: { id: paymentId, order_id: orderId, amount, currency: 'INR' } } } });

  describe('the real app, in production middleware order', () => {
    it('webhook: bad signature -> 400 envelope with a request id; nothing parsed or credited', async () => {
      const res = await post(captured('order_x', 'pay_x', 10000), 'deadbeef');
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ success: false, data: null });
      expect(res.body.meta.requestId).toBeTruthy();
      expect(await WalletLedger.countDocuments({})).toBe(0);
    });

    it('webhook: a correctly signed order is credited through the real app, once, under parallel delivery', async () => {
      const { user, auth } = await makeUser();
      const created = await request(app).post('/api/v1/wallet/orders').set(auth).set('Idempotency-Key', 'real-app-1').send({ amountRupees: 100 });
      expect(created.status).toBe(201);
      const raw = captured(created.body.data.razorpayOrderId, 'pay_real_app', 10000);
      const results = await Promise.all(Array.from({ length: 4 }, () => post(raw, sign(raw))));
      expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200]);
      expect(await WalletLedger.countDocuments({ userId: user._id })).toBe(1);
      expect((await request(app).get('/api/v1/wallet').set(auth)).body.data.balancePaise).toBe(10000);
    });

    it('the webhook is not subject to the API rate limiter or JSON body size handling', async () => {
      const raw = JSON.stringify({ event: 'something.else', pad: 'x'.repeat(200000) });
      const res = await post(raw, sign(raw));
      expect(res.status).toBe(200); // > 100kb (express.json default) is fine: it is read raw, up to 1mb
    });

    it('legacy signup switch on the REAL routes: enabled by default, 410 when set to gone, /auth/register untouched', async () => {
      const original = config.legacy_signup_mode;
      try {
        config.legacy_signup_mode = 'gone';
        const calls = [
          request(app).post('/api/v1/users/create').send({ email: 'x@example.com', password: 'whatever1', role: 'patient' }),
          request(app).post('/api/v1/users/create-user-verify-otp').send({ otp: '123456' }),
          request(app).patch('/api/v1/otp/resend-otp').send({ purpose: 'email-verification' }),
        ];
        for (const r of await Promise.all(calls)) {
          expect(r.status).toBe(410);
          expect(r.headers.deprecation).toBe('true');
          expect(r.body.meta.successor).toBe('/api/v1/auth/register');
        }
        // the supported flow is not affected by the switch (it fails validation, not with 410)
        expect((await request(app).post('/api/v1/auth/register').send({})).status).toBe(400);

        config.legacy_signup_mode = 'enabled';
        expect((await request(app).post('/api/v1/users/create').send({})).status).toBe(400); // old validation, not 410
      } finally {
        config.legacy_signup_mode = original;
      }
    });

    it('POST /users/testing-email is no longer a public mail relay', async () => {
      const anon = await request(app).post('/api/v1/users/testing-email').send({ email: 'victim@example.com', otp: '<a href="evil">x</a>', expiredAt: 'now' });
      expect(anon.status).toBe(401);
      const patient = await makeUser();
      const asPatient = await request(app).post('/api/v1/users/testing-email').set(patient.auth).send({ email: 'victim@example.com', otp: '1', expiredAt: 'now' });
      expect(asPatient.status).toBe(403);
    });
  });

  describe('reconciliation findings are not duplicated by webhook retries', () => {
    it('five deliveries of a webhook for an unknown order leave one open finding', async () => {
      const raw = captured('order_ghost', 'pay_ghost', 10000);
      for (let i = 0; i < 5; i += 1) expect((await post(raw, sign(raw))).status).toBe(200);
      expect(await ReconciliationFinding.countDocuments({ checkName: 'razorpay_unknown_order' })).toBe(1);
    });

    it('a distinct payment still gets its own finding', async () => {
      const a = captured('order_ghost', 'pay_ghost_a', 10000);
      const b = captured('order_ghost', 'pay_ghost_b', 10000);
      await post(a, sign(a));
      await post(b, sign(b));
      expect(await ReconciliationFinding.countDocuments({ checkName: 'razorpay_unknown_order' })).toBe(2);
    });
  });

  describe('ledger consistency under mixed concurrent activity', () => {
    it('webhook credit + parallel debits + a refund leave a consistent chain and a matching cache', async () => {
      const { user, auth } = await makeUser();
      const seed = (amount: number, key: string) =>
        runInTransaction((s) => walletService.append(s, { userId: user._id as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: amount, idempotencyKey: key }));
      const debit = (amount: number, key: string, callId?: unknown) =>
        runInTransaction((s) =>
          walletService.append(s, { userId: user._id as never, type: TYPE.CALL_CHARGE, direction: DIR.DEBIT, amountPaise: amount, idempotencyKey: key, referenceType: 'call', referenceId: (callId as never) ?? null }),
        );

      await seed(3000, 'seed');
      const created = await request(app).post('/api/v1/wallet/orders').set(auth).set('Idempotency-Key', 'mix-1').send({ amountRupees: 100 });
      const raw = captured(created.body.data.razorpayOrderId, 'pay_mix', 10000);

      const callId = new mongoose.Types.ObjectId();
      await Call.collection.insertOne({ _id: callId, patientId: user._id, doctorId: new mongoose.Types.ObjectId(), status: 'completed' });
      await debit(1000, `call:${callId}:charge`, callId);

      const admin = await makeUser('admin');
      await Promise.allSettled([
        post(raw, sign(raw)),
        post(raw, sign(raw)),
        ...Array.from({ length: 6 }, (_, i) => debit(500, `mix-debit-${i}`)),
        request(app).post('/api/v1/admin/refunds').set(admin.auth).send({ callId: String(callId), reason: 'audit refund' }),
      ]);

      const rows = await assertChain(user._id);
      expect(rows.filter((r) => r.type === 'topup' && r.idempotencyKey === 'razorpay:payment:pay_mix')).toHaveLength(1);
      expect(rows.filter((r) => r.type === 'refund')).toHaveLength(1);
      // 3000 seed + 10000 top-up + 1000 refund - 1000 first charge - up to 6 x 500
      const finalBalance = await walletService.getBalance(user._id);
      const debitsApplied = rows.filter((r) => r.idempotencyKey.startsWith('mix-debit-')).length;
      expect(finalBalance).toBe(3000 + 10000 + 1000 - 1000 - debitsApplied * 500);
    });

    it('a paid order always points at exactly one ledger entry carrying the same amount', async () => {
      const { user, auth } = await makeUser();
      const created = await request(app).post('/api/v1/wallet/orders').set(auth).set('Idempotency-Key', 'link-1').send({ amountRupees: 100 });
      const raw = captured(created.body.data.razorpayOrderId, 'pay_link', 10000);
      await post(raw, sign(raw));
      const order = (await PaymentOrder.findById(created.body.data.paymentOrderId))!;
      const entry = (await WalletLedger.findById(order.ledgerEntryId))!;
      expect(entry.amountPaise).toBe(order.amountPaise);
      expect(String(entry.userId)).toBe(String(user._id));
      expect(String(entry.referenceId)).toBe(String(order._id));
      expect(await WalletLedger.countDocuments({ referenceId: order._id })).toBe(1);
    });
  });
});
