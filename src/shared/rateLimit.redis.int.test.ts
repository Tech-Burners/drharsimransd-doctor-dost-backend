// REAL Redis integration test. Skipped unless TEST_REDIS_URL is set, so `npm test` stays
// runnable without Docker:
//
//   docker run -d --rm --name dd-test-redis -p 6390:6379 redis:7
//   TEST_REDIS_URL=redis://localhost:6390 npx jest src/shared/rateLimit.redis
//
// The URL's database is flushed before each test. Point it ONLY at a throwaway Redis.
import IORedis from 'ioredis';
import express from 'express';
import request from 'supertest';
import { useTestDb } from '../test/helpers/db';
import { clear, cooldown, enforce, hit, lock, lockRemaining, setRateLimitStore } from './rateLimit';
import { closeRedis } from './redis';
import config from '../app/config';
import globalErrorHandler from '../app/middleware/globalErrorhandler';
import { authRoutes } from '../app/modules/auth/auth.route';
import { User } from '../app/modules/user/user.model';
import { InMemorySmsProvider, setSmsProvider } from './sms';

const url = process.env.TEST_REDIS_URL;
const d = url ? describe : describe.skip;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

d('rateLimit against a real Redis', () => {
  const db = useTestDb();
  let redis: IORedis;

  beforeAll(() => {
    redis = new IORedis(url as string);
  });
  beforeEach(async () => {
    await redis.flushdb();
    setRateLimitStore(redis as never);
  });
  afterAll(async () => {
    setRateLimitStore(null);
    await redis.quit();
  });

  it('hit(): allows exactly `limit` events inside the window, and every key has a TTL', async () => {
    const results = [];
    for (let i = 0; i < 7; i += 1) results.push(await hit('t:basic', 5, 30));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, true, true, false, false]);
    const ttl = await redis.ttl('t:basic');
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);
    expect(results[5].retryAfterSeconds).toBeGreaterThan(0);
  });

  it('hit(): the window really expires and the counter restarts', async () => {
    await hit('t:expiry', 1, 1);
    expect((await hit('t:expiry', 1, 1)).allowed).toBe(false);
    await sleep(1300);
    expect(await redis.exists('t:expiry')).toBe(0);
    expect((await hit('t:expiry', 1, 1)).allowed).toBe(true);
  });

  it('hit(): 60 concurrent requests allow exactly `limit` (no lost or double counts)', async () => {
    const results = await Promise.all(Array.from({ length: 60 }, () => hit('t:concurrent', 10, 30)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(await redis.get('t:concurrent')).toBe('60');
  });

  it('cooldown(): of 30 concurrent callers exactly one acquires the slot', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, () => cooldown('t:cd', 30)));
    expect(results.filter((r) => r.acquired)).toHaveLength(1);
    expect(results.find((r) => !r.acquired)!.retryAfterSeconds).toBeGreaterThan(0);
    expect(await redis.ttl('t:cd')).toBeGreaterThan(0);
  });

  it('lock / lockRemaining / clear', async () => {
    expect(await lockRemaining('t:lock')).toBe(0);
    await lock('t:lock', 30);
    const left = await lockRemaining('t:lock');
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThanOrEqual(30);
    await clear('t:lock');
    expect(await lockRemaining('t:lock')).toBe(0);
  });

  it('enforce() throws 429 once the limit is passed', async () => {
    await enforce('t:enf', 1, 30);
    await expect(enforce('t:enf', 1, 30)).rejects.toMatchObject({ statusCode: 429 });
  });

  it('leaves no key without an expiry after a mixed workload', async () => {
    await Promise.all([
      ...Array.from({ length: 20 }, (_, i) => hit(`t:mix:${i % 4}`, 3, 30)),
      cooldown('t:mix:cd', 30),
      lock('t:mix:lock', 30),
    ]);
    const keys = await redis.keys('t:mix:*');
    for (const k of keys) expect(await redis.ttl(k)).toBeGreaterThan(0);
  });

  it('auth over real Redis: 5 failed logins lock the account; the lock then clears', async () => {
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRoutes);
    app.use(globalErrorHandler);
    await User.create({ name: 'R', email: 'real@example.com', password: 'Str0ng-Passw0rd', role: 'patient' });
    const attempt = (pw: string) => request(app).post('/api/v1/auth/login').send({ email: 'real@example.com', password: pw });
    for (let i = 0; i < 5; i += 1) expect((await attempt('wrong')).status).toBe(401);
    expect((await attempt('Str0ng-Passw0rd')).status).toBe(429);
    expect(await redis.ttl('login:lock:real@example.com')).toBeGreaterThan(0);
    await redis.del('login:lock:real@example.com');
    expect((await attempt('Str0ng-Passw0rd')).status).toBe(200);
    expect(await redis.exists('login:fail:real@example.com')).toBe(0);
  });

  it('auth over real Redis: the OTP resend cooldown holds', async () => {
    const sms = new InMemorySmsProvider();
    setSmsProvider(sms);
    const app = express();
    app.use(express.json());
    app.use('/api/v1/auth', authRoutes);
    app.use(globalErrorHandler);
    await User.create({ name: 'D', email: 'doc@example.com', password: 'Str0ng-Passw0rd', role: 'doctor', phone: '+919876500001' });
    const { accessToken } = (
      await request(app).post('/api/v1/auth/login').send({ email: 'doc@example.com', password: 'Str0ng-Passw0rd' })
    ).body.data;
    const send = () => request(app).post('/api/v1/auth/phone/send-otp').set('Authorization', `Bearer ${accessToken}`);
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].sort()).toEqual([200, 429]); // concurrent: exactly one wins
    expect(sms.sent).toHaveLength(1);
    setSmsProvider(null);
    expect(db.uri()).toBeTruthy();
  });
});

// The outage path does not need a live Redis: it needs a dead one.
describe('rateLimit when Redis is unreachable (config.redis_url, real ioredis client)', () => {
  const original = config.redis_url;
  beforeAll(() => {
    setRateLimitStore(null);
    config.redis_url = 'redis://127.0.0.1:1'; // nothing listens on port 1
  });
  afterAll(async () => {
    config.redis_url = original;
  });

  it('fails closed with 503 within a few seconds instead of hanging', async () => {
    const started = Date.now();
    await expect(hit('t:down', 5, 30)).rejects.toMatchObject({ statusCode: 503 });
    expect(Date.now() - started).toBeLessThan(4000);
  });

  it('closeRedis() returns promptly for a client that never connected (it used to hang forever)', async () => {
    const started = Date.now();
    await closeRedis();
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('closeRedis against a live Redis', () => {
  const d2 = url ? describe : describe.skip;
  d2('connected', () => {
    it('quits cleanly', async () => {
      const original = config.redis_url;
      config.redis_url = url;
      try {
        const { getRedis } = await import('./redis');
        await getRedis().ping();
        const started = Date.now();
        await closeRedis();
        expect(Date.now() - started).toBeLessThan(1500);
      } finally {
        config.redis_url = original;
      }
    });
  });
});
