// INTEGRATION tests against a real one-node replica set. No transaction is mocked.
//
// The first test below is the TEMPLATE for the concurrency tests in Phases 6 and 7:
//   1. build the real object graph (user, wallet, order);
//   2. fire the SAME operation several times at once, over HTTP or the service;
//   3. assert on the DATABASE (row counts, balances), not just on the responses.
import { createHmac } from 'crypto';
import express from 'express';
import mongoose from 'mongoose';
import request from 'supertest';
import { useTestDb } from '../../../test/helpers/db';
import config from '../../config';
import globalErrorHandler from '../../middleware/globalErrorhandler';
import { rawBodyParser, webhookRouter } from '../../routes/webhook.route';
import { walletRoutes } from './wallet.route';
import { refundRoutes } from '../refund/refund.route';
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
import { IdempotencyKey } from '../idempotencyKey/idempotencyKey.model';
import { ReconciliationFinding } from '../reconciliationFinding/reconciliationFinding.model';
import { Call } from '../call/call.model';
import { WALLET_LEDGER_DIRECTION as DIR, WALLET_LEDGER_TYPE as TYPE } from './walletLedger.constants';

const SECRET = 'whsec_test_secret';
const PASSWORD = 'Str0ng-Passw0rd';

const buildApp = () => {
  const app = express();
  // Same order as src/app.ts: the webhook sees raw bytes, everything else sees JSON.
  app.use('/api/v1/webhooks', rawBodyParser, webhookRouter);
  app.use(express.json());
  app.use('/api/v1/wallet', walletRoutes);
  app.use('/api/v1/admin/refunds', refundRoutes);
  app.use(globalErrorHandler);
  return app;
};

class FakeGateway implements PaymentGateway {
  calls: Array<{ amountPaise: number; notes: Record<string, string> }> = [];
  failWith: Error | null = null;
  async createOrder(input: { amountPaise: number; notes: Record<string, string> }) {
    if (this.failWith) throw this.failWith;
    this.calls.push(input);
    return { id: `order_${this.calls.length}_${Math.random().toString(36).slice(2, 8)}`, amountPaise: input.amountPaise, currency: 'INR' };
  }
}

let seq = 0;

describe('Phase 5 wallet and payments', () => {
  const db = useTestDb();
  const app = buildApp();
  let gateway: FakeGateway;
  let redis: FakeRedis;

  const original = { ...config.razorpay };
  beforeEach(() => {
    gateway = new FakeGateway();
    setPaymentGateway(gateway);
    redis = new FakeRedis();
    setRateLimitStore(redis);
    config.razorpay.webhookSecret = SECRET;
    config.razorpay.keyId = 'rzp_test_public';
  });
  afterAll(() => {
    setPaymentGateway(null);
    setRateLimitStore(null);
    config.razorpay.webhookSecret = original.webhookSecret;
    config.razorpay.keyId = original.keyId;
  });

  const makeUser = async (role = 'patient') => {
    seq += 1;
    const user = await User.create({ name: `U${seq}`, email: `w${seq}@example.com`, password: PASSWORD, role, emailVerified: true });
    const { accessToken } = await issueTokenPair(user);
    return { user, auth: { Authorization: `Bearer ${accessToken}` } };
  };

  const createOrder = (auth: Record<string, string>, key: string, body: object = { amountRupees: 100 }) =>
    request(app).post('/api/v1/wallet/orders').set(auth).set('Idempotency-Key', key).send(body);

  const eventFor = (order: { razorpayOrderId: string; amountPaise: number }, paymentId: string, extra: object = {}) => ({
    event: 'payment.captured',
    payload: { payment: { entity: { id: paymentId, order_id: order.razorpayOrderId, amount: order.amountPaise, currency: 'INR', status: 'captured', ...extra } } },
  });
  const sign = (raw: string, secret = SECRET) => createHmac('sha256', secret).update(raw).digest('hex');
  const deliver = (event: object, opts: { signature?: string | null; raw?: string } = {}) => {
    const raw = opts.raw ?? JSON.stringify(event);
    const req = request(app).post('/api/v1/webhooks/razorpay').set('Content-Type', 'application/json');
    if (opts.signature !== null) req.set('X-Razorpay-Signature', opts.signature ?? sign(raw));
    return req.send(raw);
  };

  /** A patient with a created (unpaid) order. */
  const withOrder = async (amountRupees = 100) => {
    const { user, auth } = await makeUser();
    const res = await createOrder(auth, `key-${Math.random()}`, { amountRupees });
    expect(res.status).toBe(201);
    const order = (await PaymentOrder.findById(res.body.data.paymentOrderId))!;
    return { user, auth, order };
  };

  const ledgerCount = (userId: unknown) => WalletLedger.countDocuments({ userId });

  // ====================================================================================
  // THE TEMPLATE CONCURRENCY TEST
  // ====================================================================================
  describe('concurrent webhook deliveries', () => {
    it('credits exactly once when the same Razorpay webhook is delivered 6 times at once', async () => {
      const { user, order } = await withOrder(100);
      const event = eventFor(order, 'pay_concurrent_1');

      const responses = await Promise.all(Array.from({ length: 6 }, () => deliver(event)));

      // Every delivery is acknowledged, so Razorpay stops retrying.
      expect(responses.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200]);
      const outcomes = responses.map((r) => r.body.data.outcome).sort();
      expect(outcomes.filter((o) => o === 'credited')).toHaveLength(1);
      expect(outcomes.filter((o) => o === 'duplicate')).toHaveLength(5);

      // The DATABASE shows one credit.
      expect(await ledgerCount(user._id)).toBe(1);
      const entry = (await WalletLedger.findOne({ userId: user._id }))!;
      expect(entry.type).toBe('topup');
      expect(entry.direction).toBe('credit');
      expect(entry.amountPaise).toBe(10000);
      expect(entry.balanceAfterPaise).toBe(10000);
      expect(entry.idempotencyKey).toBe('razorpay:payment:pay_concurrent_1');

      const wallet = (await Wallet.findOne({ userId: user._id }))!;
      expect(wallet.balancePaise).toBe(10000);
      expect(String(wallet.lastLedgerEntryId)).toBe(String(entry._id));

      const paid = (await PaymentOrder.findById(order._id))!;
      expect(paid.status).toBe('paid');
      expect(paid.razorpayPaymentId).toBe('pay_concurrent_1');
      expect(paid.signatureVerified).toBe(true);
      expect(String(paid.ledgerEntryId)).toBe(String(entry._id));
      expect(paid.paidAt).toBeTruthy();

      expect(await walletService.getBalance(user._id)).toBe(10000);
    });

    it('a later redelivery is acknowledged and changes nothing', async () => {
      const { user, order } = await withOrder();
      const event = eventFor(order, 'pay_redeliver');
      expect((await deliver(event)).body.data.outcome).toBe('credited');
      const again = await deliver(event);
      expect(again.status).toBe(200);
      expect(again.body.data.outcome).toBe('duplicate');
      expect(await ledgerCount(user._id)).toBe(1);
      expect(await walletService.getBalance(user._id)).toBe(10000);
    });

    it('order.paid for the same payment does not credit a second time', async () => {
      const { user, order } = await withOrder();
      await deliver(eventFor(order, 'pay_both'));
      const res = await deliver({ ...eventFor(order, 'pay_both'), event: 'order.paid' });
      expect(res.body.data.outcome).toBe('duplicate');
      expect(await ledgerCount(user._id)).toBe(1);
    });

    it('commits the ledger, the cache and the order together: a failure rolls all of them back', async () => {
      const { user, order } = await withOrder();
      const spy = jest.spyOn(PaymentOrder, 'updateOne').mockRejectedValueOnce(new Error('disk on fire'));
      const failed = await deliver(eventFor(order, 'pay_atomic'));
      spy.mockRestore();

      expect(failed.status).toBe(500); // 5xx so Razorpay retries
      expect(await ledgerCount(user._id)).toBe(0);
      expect((await Wallet.findOne({ userId: user._id }))!.balancePaise).toBe(0);
      expect((await PaymentOrder.findById(order._id))!.status).toBe('created');

      // the retry then succeeds cleanly
      expect((await deliver(eventFor(order, 'pay_atomic'))).body.data.outcome).toBe('credited');
      expect(await ledgerCount(user._id)).toBe(1);
    });
  });

  // ====================================================================================
  // Webhook verification
  // ====================================================================================
  describe('webhook signature', () => {
    it('drops a request with a wrong, missing or tampered signature and credits nothing', async () => {
      const { user, order } = await withOrder();
      const event = eventFor(order, 'pay_forged');
      const raw = JSON.stringify(event);

      expect((await deliver(event, { signature: sign(raw, 'wrong-secret') })).status).toBe(400);
      expect((await deliver(event, { signature: null })).status).toBe(400);
      // signed for one body, sent another
      const tampered = JSON.stringify(eventFor(order, 'pay_forged', { amount: 99999999 }));
      expect((await deliver(event, { raw: tampered, signature: sign(raw) })).status).toBe(400);

      expect(await ledgerCount(user._id)).toBe(0);
      expect((await PaymentOrder.findById(order._id))!.status).toBe('created');
    });

    it('verifies against the RAW bytes: the same JSON with different whitespace needs its own signature', async () => {
      const { user, order } = await withOrder();
      const spaced = JSON.stringify(eventFor(order, 'pay_raw'), null, 2);
      expect((await deliver({}, { raw: spaced, signature: sign(JSON.stringify(eventFor(order, 'pay_raw'))) })).status).toBe(400);
      expect((await deliver({}, { raw: spaced, signature: sign(spaced) })).status).toBe(200);
      expect(await ledgerCount(user._id)).toBe(1);
    });

    it('fails closed when no webhook secret is configured', async () => {
      const { user, order } = await withOrder();
      const event = eventFor(order, 'pay_nosecret');
      config.razorpay.webhookSecret = undefined;
      const res = await deliver(event, { signature: sign(JSON.stringify(event), '') });
      expect(res.status).toBe(400);
      expect(await ledgerCount(user._id)).toBe(0);
    });

    it('rejects a malformed body even with a valid signature', async () => {
      const raw = '{not json';
      expect((await deliver({}, { raw, signature: sign(raw) })).status).toBe(400);
    });

    it('acknowledges events it does not act on without crediting', async () => {
      const { user, order } = await withOrder();
      const res = await deliver({ ...eventFor(order, 'pay_failed_evt'), event: 'payment.failed' });
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('ignored');
      expect(await ledgerCount(user._id)).toBe(0);
    });
  });

  describe('webhook anomalies are never credited blindly', () => {
    it('amount mismatch: nothing credited, critical finding recorded', async () => {
      const { user, order } = await withOrder(100);
      const res = await deliver(eventFor(order, 'pay_mismatch', { amount: 50000 }));
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('rejected');
      expect(await ledgerCount(user._id)).toBe(0);
      const f = await ReconciliationFinding.findOne({ checkName: 'razorpay_amount_mismatch' }).lean();
      expect(f?.severity).toBe('critical');
    });

    it('unknown order: nothing credited, critical finding recorded', async () => {
      const res = await deliver(eventFor({ razorpayOrderId: 'order_nobody', amountPaise: 10000 }, 'pay_unknown'));
      expect(res.status).toBe(200);
      expect(res.body.data.outcome).toBe('rejected');
      expect(await WalletLedger.countDocuments({})).toBe(0);
      expect((await ReconciliationFinding.findOne({ checkName: 'razorpay_unknown_order' }).lean())?.severity).toBe('critical');
    });

    it('a second, different payment against an already paid order is not credited', async () => {
      const { user, order } = await withOrder();
      await deliver(eventFor(order, 'pay_first'));
      const res = await deliver(eventFor(order, 'pay_second'));
      expect(res.body.data.outcome).toBe('rejected');
      expect(await ledgerCount(user._id)).toBe(1);
      expect(await ReconciliationFinding.countDocuments({ checkName: 'razorpay_second_payment_for_paid_order' })).toBe(1);
    });
  });

  // ====================================================================================
  // Orders
  // ====================================================================================
  describe('POST /wallet/orders', () => {
    it('creates an order for the pack amount, never for an amount in the body', async () => {
      const { auth } = await makeUser();
      const res = await createOrder(auth, 'k-amount', { amountRupees: 500, amountPaise: 1, amount: 1, rate: 1, userId: 'someone' } as never);
      expect(res.status).toBe(201);
      expect(res.body.data.amountPaise).toBe(50000);
      expect(res.body.data.razorpayKeyId).toBe('rzp_test_public');
      expect(gateway.calls).toHaveLength(1);
      expect(gateway.calls[0].amountPaise).toBe(50000);
      const order = await PaymentOrder.findOne({ razorpayOrderId: res.body.data.razorpayOrderId });
      expect(order?.amountPaise).toBe(50000);
      expect(order?.status).toBe('created');
      expect(order?.ledgerEntryId).toBeNull();
    });

    it('creating an order does not move any money', async () => {
      const { user, auth } = await makeUser();
      await createOrder(auth, 'k-nomoney');
      expect(await ledgerCount(user._id)).toBe(0);
      expect(await walletService.getBalance(user._id)).toBe(0);
    });

    it('ignores any user id in the body: the order belongs to the token subject', async () => {
      const a = await makeUser();
      const b = await makeUser();
      const res = await createOrder(a.auth, 'k-owner', { amountRupees: 100, userId: String(b.user._id) } as never);
      const order = await PaymentOrder.findById(res.body.data.paymentOrderId);
      expect(String(order?.userId)).toBe(String(a.user._id));
    });

    it('a retry with the same Idempotency-Key returns the first response: one gateway call, one order', async () => {
      const { user, auth } = await makeUser();
      const first = await createOrder(auth, 'k-retry');
      const retry = await createOrder(auth, 'k-retry');
      expect(retry.status).toBe(201);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(retry.body).toEqual(first.body);
      expect(gateway.calls).toHaveLength(1);
      expect(await PaymentOrder.countDocuments({ userId: user._id })).toBe(1);
    });

    it('two simultaneous requests with one key create one order', async () => {
      const { user, auth } = await makeUser();
      const results = await Promise.all([createOrder(auth, 'k-race'), createOrder(auth, 'k-race')]);
      expect(results.filter((r) => r.status === 201).length).toBeGreaterThanOrEqual(1);
      expect(gateway.calls).toHaveLength(1);
      expect(await PaymentOrder.countDocuments({ userId: user._id })).toBe(1);
    });

    it('the same key with a different body is a 409, a missing key a 400', async () => {
      const { auth } = await makeUser();
      await createOrder(auth, 'k-diff', { amountRupees: 100 });
      expect((await createOrder(auth, 'k-diff', { amountRupees: 500 })).status).toBe(409);
      const noKey = await request(app).post('/api/v1/wallet/orders').set(auth).send({ amountRupees: 100 });
      expect(noKey.status).toBe(400);
    });

    it('enforces the limits on the server: Rs 100 minimum, Rs 50,000 maximum, inclusive', async () => {
      const { auth } = await makeUser();
      expect((await createOrder(auth, 'k-99', { amountRupees: 99 })).status).toBe(400);
      expect((await createOrder(auth, 'k-50001', { amountRupees: 50001 })).status).toBe(400);
      expect(gateway.calls).toHaveLength(0);
      const lo = await createOrder(auth, 'k-100', { amountRupees: 100 });
      const hi = await createOrder(auth, 'k-50000', { amountRupees: 50000 });
      expect([lo.status, hi.status]).toEqual([201, 201]);
      expect(lo.body.data.amountPaise).toBe(10000);
      expect(hi.body.data.amountPaise).toBe(5000000); // integer paise internally
    });

    it('accepts whole rupees only: fractions, paise-looking strings, zero, negatives and non-numbers are rejected', async () => {
      const { auth } = await makeUser();
      let n = 0;
      for (const bad of [100.5, 100.01, '100', '100.50', 0, -100, null, true, [], {}, NaN, 1e21]) {
        n += 1;
        const res = await createOrder(auth, `k-bad-${n}`, { amountRupees: bad } as never);
        expect(res.status).toBe(400);
      }
      expect((await createOrder(auth, 'k-missing', {})).status).toBe(400);
      expect((await createOrder(auth, 'k-old-shape', { packId: 'small' } as never)).status).toBe(400);
      expect(gateway.calls).toHaveLength(0);
    });

    it('an amount in paise sent by mistake cannot slip through the limit', async () => {
      const { auth } = await makeUser();
      // 10000 would be Rs 10,000 here (valid); 5000000 would be Rs 50 lakh (over the maximum)
      expect((await createOrder(auth, 'k-lakh', { amountRupees: 5000000 })).status).toBe(400);
    });

    it('uses the limits stored in PlatformSetting, and the defaults when none exist', async () => {
      const { PlatformSetting } = await import('../platformSetting/platformSetting.model');
      const { auth } = await makeUser();
      expect((await createOrder(auth, 'k-def', { amountRupees: 100 })).status).toBe(201); // no document: defaults
      await PlatformSetting.create({ minTopupPaise: 50000, maxTopupPaise: 200000 });
      expect((await createOrder(auth, 'k-below', { amountRupees: 100 })).status).toBe(400);
      expect((await createOrder(auth, 'k-ok', { amountRupees: 500 })).status).toBe(201);
      expect((await createOrder(auth, 'k-above', { amountRupees: 2001 })).status).toBe(400);
      expect((await request(app).get('/api/v1/wallet').set(auth)).body.data.topupLimits).toEqual({ minPaise: 50000, maxPaise: 200000 });
    });

    it('an existing settings document written before these fields still works (defaults apply)', async () => {
      const { PlatformSetting } = await import('../platformSetting/platformSetting.model');
      const { auth } = await makeUser();
      await PlatformSetting.collection.insertOne({
        commissionPct: 20, dayStartTime: '06:00', nightStartTime: '20:00', minWalletPaise: 10000,
        urgentCallDayRatePaise: 0, urgentCallNightRatePaise: 0, roundingMode: 'up',
        prescriptionWindowMinutes: 120, reminderMinutes: 60, recordingRetentionYears: 3, minWithdrawalPaise: 10000,
      });
      expect((await request(app).get('/api/v1/wallet').set(auth)).body.data.topupLimits).toEqual({ minPaise: 10000, maxPaise: 5000000 });
      expect((await createOrder(auth, 'k-legacy', { amountRupees: 100 })).status).toBe(201);
    });

    it('the settings schema rejects a fractional-rupee limit and a minimum above the maximum', async () => {
      const { PlatformSetting } = await import('../platformSetting/platformSetting.model');
      await expect(PlatformSetting.create({ minTopupPaise: 10050 })).rejects.toThrow(/whole number of rupees/);
      await expect(PlatformSetting.create({ minTopupPaise: 300000, maxTopupPaise: 200000 })).rejects.toThrow(/must not exceed/);
      await expect(PlatformSetting.create({ recoveryPeriodDays: 0 })).rejects.toThrow();
    });

    it('a provider failure is a 502, leaves no order, and the same key can be retried', async () => {
      const { user, auth } = await makeUser();
      gateway.failWith = new Error('razorpay down');
      expect((await createOrder(auth, 'k-fail')).status).toBeGreaterThanOrEqual(500);
      expect(await PaymentOrder.countDocuments({ userId: user._id })).toBe(0);
      expect(await IdempotencyKey.countDocuments({ key: 'k-fail' })).toBe(0);
      gateway.failWith = null;
      expect((await createOrder(auth, 'k-fail')).status).toBe(201);
    });

    describe('abuse limits: order creation cannot make unlimited Razorpay orders', () => {
      it('allows 10 orders per user per hour, then 429 without touching Razorpay', async () => {
        const { user, auth } = await makeUser();
        for (let i = 0; i < 10; i += 1) expect((await createOrder(auth, `rl-${i}`)).status).toBe(201);
        await PaymentOrder.updateMany({}, { status: 'paid' }); // take the unpaid-order cap out: this isolates the Redis layer
        const blocked = await createOrder(auth, 'rl-11');
        expect(blocked.status).toBe(429);
        expect(gateway.calls).toHaveLength(10); // the 11th never reached the gateway
        expect(await PaymentOrder.countDocuments({ userId: user._id })).toBe(10);
      });

      it('different Idempotency-Keys do NOT get around the limit; a replay of the same key does not spend quota', async () => {
        const { auth } = await makeUser();
        for (let i = 0; i < 9; i += 1) await createOrder(auth, `rl-${i}`);
        for (let i = 0; i < 20; i += 1) expect((await createOrder(auth, 'rl-0')).status).toBe(201); // 20 replays
        expect((await createOrder(auth, 'rl-new')).status).toBe(201); // the 10th real order
        await PaymentOrder.updateMany({}, { status: 'paid' }); // isolate the Redis layer
        expect((await createOrder(auth, 'rl-over')).status).toBe(429);
        expect(gateway.calls).toHaveLength(10);
      });

      it('the quota is per user: one user hitting the limit does not block another', async () => {
        const a = await makeUser();
        const b = await makeUser();
        for (let i = 0; i < 10; i += 1) await createOrder(a.auth, `a-${i}`);
        await PaymentOrder.updateMany({}, { status: 'paid' });
        expect((await createOrder(a.auth, 'a-over')).status).toBe(429);
        expect((await createOrder(b.auth, 'b-0')).status).toBe(201);
      });

      it('has a per-IP limit of 30 per hour across users', async () => {
        const users = await Promise.all([makeUser(), makeUser(), makeUser(), makeUser()]);
        let created = 0;
        let lastStatus = 0;
        for (let i = 0; i < 32; i += 1) {
          const res = await createOrder(users[i % 4].auth, `ip-${i}`);
          lastStatus = res.status;
          if (res.status === 201) created += 1;
        }
        expect(created).toBe(30);
        expect(lastStatus).toBe(429);
        expect(gateway.calls).toHaveLength(30);
      });

      it('the window resets after an hour', async () => {
        const { auth } = await makeUser();
        for (let i = 0; i < 10; i += 1) await createOrder(auth, `w-${i}`);
        await PaymentOrder.updateMany({}, { status: 'paid' }); // keep the DB cap out of this test
        expect((await createOrder(auth, 'w-over')).status).toBe(429);
        redis.advance(3601);
        expect((await createOrder(auth, 'w-again')).status).toBe(201);
      });

      it('caps UNPAID orders at 10 per 24h in the database, even with Redis fresh; paid and old orders do not count', async () => {
        const { user, auth } = await makeUser();
        const wallet = await walletService.ensureWallet(user._id);
        const make = (status: string, createdAt: Date, n: number) =>
          PaymentOrder.collection.insertOne({
            userId: user._id, walletId: wallet._id, amountPaise: 10000, razorpayOrderId: `order_cap_${n}`, status,
            signatureVerified: false, ledgerEntryId: null, razorpayPaymentId: null, paidAt: null, createdAt, updatedAt: createdAt,
          });
        for (let i = 0; i < 9; i += 1) await make('created', new Date(), i);
        await make('paid', new Date(), 100); // paid: not counted
        await make('created', new Date(Date.now() - 25 * 3600_000), 101); // older than 24h: not counted
        expect((await createOrder(auth, 'cap-1')).status).toBe(201); // the 10th unpaid
        const blocked = await createOrder(auth, 'cap-2');
        expect(blocked.status).toBe(429);
        expect(blocked.body.message).toMatch(/unpaid/);
        expect(gateway.calls).toHaveLength(1);
      });

      it('fails closed (503) when the limiter store is down, and never calls Razorpay', async () => {
        const { auth } = await makeUser();
        redis.down = true;
        expect((await createOrder(auth, 'down-1')).status).toBe(503);
        expect(gateway.calls).toHaveLength(0);
        redis.down = false;
        expect((await createOrder(auth, 'down-1')).status).toBe(201); // the same key works once Redis is back
      });

      it('validation failures never reach the limiter or the gateway', async () => {
        const { auth } = await makeUser();
        for (let i = 0; i < 15; i += 1) expect((await createOrder(auth, `bad-${i}`, { amountRupees: 1 })).status).toBe(400);
        expect(gateway.calls).toHaveLength(0);
        expect((await createOrder(auth, 'good-1')).status).toBe(201); // quota untouched
      });

      it('leaves no limiter key without an expiry', async () => {
        const { auth } = await makeUser();
        await createOrder(auth, 'ttl-1');
        expect(redis.keysWithoutTtl()).toEqual([]);
      });
    });

    it('only patients, only when authenticated', async () => {
      expect((await request(app).post('/api/v1/wallet/orders').set('Idempotency-Key', 'k').send({ amountRupees: 100 })).status).toBe(401);
      const doctor = await makeUser('doctor');
      expect((await createOrder(doctor.auth, 'k-doc')).status).toBe(403);
      const admin = await makeUser('admin');
      expect((await createOrder(admin.auth, 'k-adm')).status).toBe(403);
    });
  });

  // ====================================================================================
  // Ledger / append
  // ====================================================================================
  describe('walletService.append', () => {
    const credit = (userId: unknown, amount: number, key: string) =>
      runInTransaction((s) =>
        walletService.append(s, { userId: userId as string, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: amount, idempotencyKey: key }),
      );
    const debit = (userId: unknown, amount: number, key: string) =>
      runInTransaction((s) =>
        walletService.append(s, { userId: userId as string, type: TYPE.CALL_CHARGE, direction: DIR.DEBIT, amountPaise: amount, idempotencyKey: key }),
      );

    it('rejects a debit that would take the balance below zero, and writes nothing', async () => {
      const { user } = await makeUser();
      await credit(user._id, 500, 'c1');
      await expect(debit(user._id, 501, 'd-over')).rejects.toMatchObject({ statusCode: 402 });
      expect(await ledgerCount(user._id)).toBe(1);
      expect(await walletService.getBalance(user._id)).toBe(500);
      expect((await Wallet.findOne({ userId: user._id }))!.balancePaise).toBe(500);
    });

    it('allows a debit down to exactly zero', async () => {
      const { user } = await makeUser();
      await credit(user._id, 500, 'c2');
      const e = await debit(user._id, 500, 'd-exact');
      expect(e.balanceAfterPaise).toBe(0);
    });

    it('a debit on an empty wallet is rejected', async () => {
      const { user } = await makeUser();
      await expect(debit(user._id, 1, 'd-empty')).rejects.toMatchObject({ statusCode: 402 });
    });

    it('rejects zero, negative, fractional and unsafe amounts, and a credit typed as a charge', async () => {
      const { user } = await makeUser();
      for (const bad of [0, -5, 1.5, Number.MAX_SAFE_INTEGER + 2, NaN]) {
        await expect(credit(user._id, bad, `bad-${bad}`)).rejects.toMatchObject({ statusCode: 400 });
      }
      await expect(
        runInTransaction((s) =>
          walletService.append(s, { userId: user._id as never, type: TYPE.CALL_CHARGE, direction: DIR.CREDIT, amountPaise: 5, idempotencyKey: 'wrong-dir' }),
        ),
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await ledgerCount(user._id)).toBe(0);
    });

    it('a duplicate idempotency key is an E11000 and writes nothing more', async () => {
      const { user } = await makeUser();
      await credit(user._id, 100, 'dup');
      await expect(credit(user._id, 100, 'dup')).rejects.toMatchObject({ code: 11000 });
      expect(await ledgerCount(user._id)).toBe(1);
      expect((await Wallet.findOne({ userId: user._id }))!.balancePaise).toBe(100);
    });

    it('concurrent credits are never lost: 12 parallel credits of 100 end at exactly 1200', async () => {
      const { user } = await makeUser();
      await Promise.all(Array.from({ length: 12 }, (_, i) => credit(user._id, 100, `par-${i}`)));
      expect(await walletService.getBalance(user._id)).toBe(1200);
      expect((await Wallet.findOne({ userId: user._id }))!.balancePaise).toBe(1200);
      const rows = await WalletLedger.find({ userId: user._id }).sort({ createdAt: 1, _id: 1 }).lean();
      expect(rows.map((r) => r.balanceAfterPaise)).toEqual([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
    });

    it('concurrent debits can never overspend: balance 500, 10 parallel debits of 100 -> exactly 5 succeed', async () => {
      const { user } = await makeUser();
      await credit(user._id, 500, 'seed');
      const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => debit(user._id, 100, `spend-${i}`)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(5);
      expect(await walletService.getBalance(user._id)).toBe(0);
      expect((await Wallet.findOne({ userId: user._id }))!.balancePaise).toBe(0);
      const min = Math.min(...(await WalletLedger.find({ userId: user._id }).lean()).map((r) => r.balanceAfterPaise));
      expect(min).toBeGreaterThanOrEqual(0);
    });

    it('getBalance reads the ledger, not the cache', async () => {
      const { user } = await makeUser();
      await credit(user._id, 700, 'ledger-truth');
      await Wallet.updateOne({ userId: user._id }, { $set: { balancePaise: 999999 } }); // poison the cache
      expect(await walletService.getBalance(user._id)).toBe(700);
    });

    it('keeps the entries strictly ordered even when written back to back', async () => {
      const { user } = await makeUser();
      for (let i = 0; i < 15; i += 1) await credit(user._id, 10, `seq-${i}`);
      const rows = await WalletLedger.find({ userId: user._id }).sort({ createdAt: 1 }).lean();
      const times = rows.map((r) => new Date(r.createdAt as Date).getTime());
      expect(new Set(times).size).toBe(15);
      expect(rows[rows.length - 1].balanceAfterPaise).toBe(150);
    });

    it('rolls the ledger entry back if the surrounding transaction aborts', async () => {
      const { user } = await makeUser();
      await expect(
        runInTransaction(async (s) => {
          await walletService.append(s, { userId: user._id as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: 100, idempotencyKey: 'abort-me' });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await ledgerCount(user._id)).toBe(0);
      expect(await Wallet.findOne({ userId: user._id }).then((w) => w?.balancePaise ?? 0)).toBe(0);
    });
  });

  // ====================================================================================
  // Refunds
  // ====================================================================================
  describe('POST /admin/refunds', () => {
    const setupCall = async () => {
      const { user: patient } = await makeUser();
      await runInTransaction((s) =>
        walletService.append(s, { userId: patient._id as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: 20000, idempotencyKey: `seed-${patient._id}` }),
      );
      const callId = new mongoose.Types.ObjectId();
      await Call.collection.insertOne({ _id: callId, patientId: patient._id, doctorId: new mongoose.Types.ObjectId(), status: 'completed' });
      await runInTransaction((s) =>
        walletService.append(s, {
          userId: patient._id as never, type: TYPE.CALL_CHARGE, direction: DIR.DEBIT, amountPaise: 6000,
          idempotencyKey: `call:${callId}:charge`, referenceType: 'call', referenceId: callId,
        }),
      );
      return { patient, callId: String(callId) };
    };
    const refund = (auth: Record<string, string>, body: object) => request(app).post('/api/v1/admin/refunds').set(auth).send(body);

    it('APPENDS a credit and leaves the original charge untouched', async () => {
      const { patient, callId } = await setupCall();
      const admin = await makeUser('admin');
      const before = await WalletLedger.find({ userId: patient._id }).sort({ createdAt: 1 }).lean();
      expect(before).toHaveLength(2);

      const res = await refund(admin.auth, { callId, reason: 'Poor audio', note: 'Patient complained' });
      expect(res.status).toBe(201);
      expect(res.body.data.amountPaise).toBe(6000);

      const after = await WalletLedger.find({ userId: patient._id }).sort({ createdAt: 1 }).lean();
      expect(after).toHaveLength(3);
      // the first two rows are byte-for-byte unchanged
      expect(after.slice(0, 2)).toEqual(before);
      const entry = after[2];
      expect(entry.type).toBe('refund');
      expect(entry.direction).toBe('credit');
      expect(entry.amountPaise).toBe(6000);
      expect(entry.balanceAfterPaise).toBe(20000);
      expect(entry.idempotencyKey).toBe(`call:${callId}:refund`);
      expect(String(entry.referenceId)).toBe(callId);
      expect(entry.description).toContain('Poor audio');
      expect(entry.metadata).toMatchObject({ reason: 'Poor audio', note: 'Patient complained', refundedBy: String(admin.user._id) });
      expect(await walletService.getBalance(patient._id)).toBe(20000);
      expect((await Wallet.findOne({ userId: patient._id }))!.balancePaise).toBe(20000);
    });

    it('does not write a SettingChangeLog row (the ledger entry is the audit)', async () => {
      const { callId } = await setupCall();
      const admin = await makeUser('admin');
      await refund(admin.auth, { callId, reason: 'Poor audio' });
      const { SettingChangeLog } = await import('../settingChangeLog/settingChangeLog.model');
      expect(await SettingChangeLog.countDocuments({})).toBe(0);
    });

    it('takes the amount from the ledger: an amount in the body is ignored', async () => {
      const { callId } = await setupCall();
      const admin = await makeUser('admin');
      const res = await refund(admin.auth, { callId, reason: 'Poor audio', amountPaise: 1, amount: 999999 });
      expect(res.body.data.amountPaise).toBe(6000);
    });

    it('refunds a call only once, even when requested twice at the same moment', async () => {
      const { patient, callId } = await setupCall();
      const admin = await makeUser('admin');
      const results = await Promise.all([
        refund(admin.auth, { callId, reason: 'Poor audio' }),
        refund(admin.auth, { callId, reason: 'Poor audio' }),
        refund(admin.auth, { callId, reason: 'Poor audio' }),
      ]);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(2);
      expect(await WalletLedger.countDocuments({ userId: patient._id, type: 'refund' })).toBe(1);
      expect(await walletService.getBalance(patient._id)).toBe(20000);
    });

    it('404 for an unknown call, 409 when the call carries no charge, 400 for a bad id', async () => {
      const admin = await makeUser('admin');
      expect((await refund(admin.auth, { callId: String(new mongoose.Types.ObjectId()), reason: 'x y z' })).status).toBe(404);
      const free = new mongoose.Types.ObjectId();
      await Call.collection.insertOne({ _id: free, patientId: new mongoose.Types.ObjectId(), doctorId: new mongoose.Types.ObjectId(), status: 'completed' });
      expect((await refund(admin.auth, { callId: String(free), reason: 'free call' })).status).toBe(409);
      expect((await refund(admin.auth, { callId: 'nope', reason: 'bad id' })).status).toBe(400);
      expect((await refund(admin.auth, { callId: String(free) })).status).toBe(400); // reason required
    });

    it('admin only', async () => {
      const { callId } = await setupCall();
      expect((await request(app).post('/api/v1/admin/refunds').send({ callId, reason: 'abc' })).status).toBe(401);
      const patient = await makeUser();
      const doctor = await makeUser('doctor');
      expect((await refund(patient.auth, { callId, reason: 'abc' })).status).toBe(403);
      expect((await refund(doctor.auth, { callId, reason: 'abc' })).status).toBe(403);
    });
  });

  // ====================================================================================
  // GET /wallet
  // ====================================================================================
  describe('GET /wallet', () => {
    it('returns the ledger-derived balance, the top-up limits and a paginated ledger, newest first', async () => {
      const { user, auth } = await makeUser();
      for (let i = 1; i <= 5; i += 1) {
        await runInTransaction((s) =>
          walletService.append(s, { userId: user._id as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: i * 100, idempotencyKey: `g-${i}` }),
        );
      }
      await Wallet.updateOne({ userId: user._id }, { $set: { balancePaise: 1 } }); // wrong cache must not leak

      const page1 = await request(app).get('/api/v1/wallet?page=1&limit=2').set(auth);
      expect(page1.status).toBe(200);
      expect(page1.body.data.balancePaise).toBe(1500);
      expect(page1.body.data.topupLimits).toEqual({ minPaise: 10000, maxPaise: 5000000 });
      expect(page1.body.data.ledger.map((e: { amountPaise: number }) => e.amountPaise)).toEqual([500, 400]);
      expect(page1.body.meta).toEqual({ page: 1, limit: 2, total: 5, totalPage: 3 });

      const page3 = await request(app).get('/api/v1/wallet?page=3&limit=2').set(auth);
      expect(page3.body.data.ledger.map((e: { amountPaise: number }) => e.amountPaise)).toEqual([100]);
    });

    it("never shows another user's entries", async () => {
      const a = await makeUser();
      const b = await makeUser();
      await runInTransaction((s) =>
        walletService.append(s, { userId: a.user._id as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise: 100, idempotencyKey: 'only-a' }),
      );
      const res = await request(app).get(`/api/v1/wallet?userId=${a.user._id}`).set(b.auth);
      expect(res.body.data.balancePaise).toBe(0);
      expect(res.body.data.ledger).toEqual([]);
    });

    it('a new patient has a zero balance; requires the patient role; validates paging', async () => {
      const { auth } = await makeUser();
      expect((await request(app).get('/api/v1/wallet').set(auth)).body.data.balancePaise).toBe(0);
      expect((await request(app).get('/api/v1/wallet')).status).toBe(401);
      expect((await request(app).get('/api/v1/wallet').set((await makeUser('doctor')).auth)).status).toBe(403);
      expect((await request(app).get('/api/v1/wallet?limit=500').set(auth)).status).toBe(400);
    });
  });

  // ====================================================================================
  // End to end
  // ====================================================================================
  it('end to end: order -> webhook -> balance on GET /wallet; the app reporting success credits nothing', async () => {
    const { user, auth } = await makeUser();
    const created = await createOrder(auth, 'e2e', { amountRupees: 500 });
    expect((await request(app).get('/api/v1/wallet').set(auth)).body.data.balancePaise).toBe(0);

    const order = (await PaymentOrder.findById(created.body.data.paymentOrderId))!;
    expect((await deliver(eventFor(order, 'pay_e2e'))).status).toBe(200);

    const wallet = await request(app).get('/api/v1/wallet').set(auth);
    expect(wallet.body.data.balancePaise).toBe(50000);
    expect(wallet.body.data.ledger).toHaveLength(1);
    expect(await ledgerCount(user._id)).toBe(1);
    expect(db.uri()).toBeTruthy();
  });
});
