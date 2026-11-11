// UNIT-level tests of the application shell. No database or Redis is needed: the health
// route is exercised with injected checks, and the default checks report both as down.
import express from 'express';
import request from 'supertest';
import app from '../app';
import { rawBodyParser, webhookRouter } from './routes/webhook.route';
import { createHealthRoutes } from './modules/health/health.route';
import { registerRoute, buildOpenApiDocument } from '../shared/openapi';

describe('application shell', () => {
  it('puts a request id on every response and echoes a well-formed one', async () => {
    const generated = await request(app).get('/api/v1/nope');
    expect(generated.headers['x-request-id']).toMatch(/[0-9a-f-]{36}/);

    const echoed = await request(app).get('/api/v1/nope').set('X-Request-Id', 'trace-abc-12345');
    expect(echoed.headers['x-request-id']).toBe('trace-abc-12345');

    const rejected = await request(app).get('/api/v1/nope').set('X-Request-Id', 'bad id!');
    expect(rejected.headers['x-request-id']).not.toBe('bad id!');
  });

  it('answers unknown routes with the standard envelope', async () => {
    const res = await request(app).get('/api/v1/does-not-exist');
    expect(res.status).toBe(404);
    expect(Object.keys(res.body).sort()).toEqual(['data', 'message', 'meta', 'success']);
    expect(res.body.success).toBe(false);
    expect(res.body.meta.requestId).toBe(res.headers['x-request-id']);
  });

  it('sets security headers and does not advertise express', async () => {
    const res = await request(app).get('/api/v1/nope');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('reports 503 when mongo and redis are unreachable', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body.data).toMatchObject({ status: 'degraded', mongo: 'down', redis: 'down' });
  });

  it('reports 200 when both are reachable, and names the one that is down', async () => {
    const mk = (mongo: boolean, redis: boolean) => {
      const a = express();
      a.use('/h', createHealthRoutes({ mongo: async () => mongo, redis: async () => redis }));
      return a;
    };
    const ok = await request(mk(true, true)).get('/h');
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ status: 'ok', mongo: 'up', redis: 'up' });

    const half = await request(mk(true, false)).get('/h');
    expect(half.status).toBe(503);
    expect(half.body.data).toMatchObject({ mongo: 'up', redis: 'down' });
  });

  it('treats a hanging dependency as down instead of hanging the endpoint', async () => {
    const a = express();
    a.use('/h', createHealthRoutes({ mongo: () => new Promise<boolean>(() => undefined), redis: async () => true }));
    const res = await request(a).get('/h');
    expect(res.status).toBe(503);
    expect(res.body.data.mongo).toBe('down');
  }, 10000);

  it('serves the OpenAPI spec including registered routes', async () => {
    const res = await request(app).get('/docs');
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.0.3');
    expect(res.body.paths['/health']).toBeDefined();
  });

  it('registry accepts further routes', () => {
    registerRoute({ method: 'get', path: '/__probe', responses: { 200: { description: 'ok' } } });
    expect(buildOpenApiDocument().paths['/__probe']).toBeDefined();
  });
});

describe('webhook raw body', () => {
  it('delivers the exact bytes, ahead of the JSON parser', async () => {
    let seen: Buffer | undefined;
    webhookRouter.post('/__test', (req, res) => {
      seen = req.body;
      res.json({ ok: true });
    });

    // Deliberately odd spacing and key order: JSON parse + stringify would change it.
    const payload = '{ "b":2,   "a":1 }';
    const res = await request(app)
      .post('/api/v1/webhooks/__test')
      .set('Content-Type', 'application/json')
      .send(payload);

    expect(res.status).toBe(200);
    expect(Buffer.isBuffer(seen)).toBe(true);
    expect(seen!.toString('utf8')).toBe(payload);
  });

  it('exports a raw parser for signature verification', () => {
    expect(typeof rawBodyParser).toBe('function');
  });
});
