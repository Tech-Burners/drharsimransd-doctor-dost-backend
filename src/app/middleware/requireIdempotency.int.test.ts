// INTEGRATION test (real replica-set database). The middleware is exercised through a
// throwaway express app; it is not applied to any real route in Phase 3.
import express from 'express';
import request from 'supertest';
import mongoose from 'mongoose';
import { useTestDb } from '../../test/helpers/db';
import { requireIdempotency, hashRequest } from './requireIdempotency';
import globalErrorHandler from './globalErrorhandler';
import { IdempotencyKey } from '../modules/idempotencyKey/idempotencyKey.model';

const userId = new mongoose.Types.ObjectId().toString();

const buildApp = (handlerCalls: { count: number }, failWith?: number) => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = { userId } as never; // stands in for authentication
    next();
  });
  app.post('/orders', requireIdempotency(), (req, res) => {
    handlerCalls.count += 1;
    if (failWith) {
      res.status(failWith).json({ success: false });
      return;
    }
    res.status(201).json({ success: true, data: { orderNo: handlerCalls.count, echo: req.body } });
  });
  app.use(globalErrorHandler);
  return app;
};

describe('requireIdempotency', () => {
  const db = useTestDb();

  it('rejects a missing Idempotency-Key with 400', async () => {
    const calls = { count: 0 };
    const res = await request(buildApp(calls)).post('/orders').send({ amount: 1 });
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(calls.count).toBe(0);
  });

  it('runs the handler once and stores the response', async () => {
    const calls = { count: 0 };
    const res = await request(buildApp(calls)).post('/orders').set('Idempotency-Key', 'key-0001').send({ a: 1 });
    expect(res.status).toBe(201);
    expect(calls.count).toBe(1);

    const stored = await IdempotencyKey.findOne({ key: 'key-0001', userId }).lean();
    expect(stored?.statusCode).toBe(201);
    expect((stored?.responseBody as { data: { orderNo: number } }).data.orderNo).toBe(1);
  });

  it('replays the stored status and body without touching the handler', async () => {
    const calls = { count: 0 };
    const app = buildApp(calls);
    const first = await request(app).post('/orders').set('Idempotency-Key', 'key-0002').send({ a: 1 });
    const second = await request(app).post('/orders').set('Idempotency-Key', 'key-0002').send({ a: 1 });

    expect(second.status).toBe(first.status);
    expect(second.body).toEqual(first.body);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(calls.count).toBe(1);
  });

  it('treats a reordered but equal body as the same request', async () => {
    const calls = { count: 0 };
    const app = buildApp(calls);
    await request(app).post('/orders').set('Idempotency-Key', 'key-0003').send({ a: 1, b: { x: 1, y: 2 } });
    const again = await request(app).post('/orders').set('Idempotency-Key', 'key-0003').send({ b: { y: 2, x: 1 }, a: 1 });
    expect(again.status).toBe(201);
    expect(calls.count).toBe(1);
  });

  it('returns 409 for the same key with a DIFFERENT body, not a replay', async () => {
    const calls = { count: 0 };
    const app = buildApp(calls);
    await request(app).post('/orders').set('Idempotency-Key', 'key-0004').send({ a: 1 });
    const res = await request(app).post('/orders').set('Idempotency-Key', 'key-0004').send({ a: 2 });
    expect(res.status).toBe(409);
    expect(calls.count).toBe(1);
  });

  it('returns 409 while the first request is still in flight', async () => {
    const calls = { count: 0 };
    const app = buildApp(calls);
    await IdempotencyKey.create({
      key: 'key-0005',
      userId,
      endpoint: 'POST /orders',
      requestHash: hashRequest('POST /orders', { a: 1 }),
    });
    const res = await request(app).post('/orders').set('Idempotency-Key', 'key-0005').send({ a: 1 });
    expect(res.status).toBe(409);
    expect(calls.count).toBe(0);
  });

  it('releases the key when the handler fails, so the client can retry', async () => {
    const failing = { count: 0 };
    await request(buildApp(failing, 500)).post('/orders').set('Idempotency-Key', 'key-0006').send({ a: 1 });
    expect(await IdempotencyKey.countDocuments({ key: 'key-0006' })).toBe(0);

    const ok = { count: 0 };
    const retry = await request(buildApp(ok)).post('/orders').set('Idempotency-Key', 'key-0006').send({ a: 1 });
    expect(retry.status).toBe(201);
    expect(ok.count).toBe(1);
  });

  it('scopes keys to the authenticated user', async () => {
    const calls = { count: 0 };
    const app = buildApp(calls);
    await request(app).post('/orders').set('Idempotency-Key', 'key-0007').send({ a: 1 });
    await IdempotencyKey.updateOne({ key: 'key-0007' }, { userId: new mongoose.Types.ObjectId() });
    const res = await request(app).post('/orders').set('Idempotency-Key', 'key-0007').send({ a: 1 });
    expect(res.status).toBe(201);
    expect(calls.count).toBe(2);
  });
});
