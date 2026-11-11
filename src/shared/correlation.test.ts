import pino from 'pino';
import { Writable } from 'stream';
import { getContext, runWithContext, setCallId } from './requestContext';
import { JOB_CONTEXT_KEY, withJobContext } from './queue';
import { REDACT_PATHS } from './logger';

describe('request context', () => {
  it('is undefined outside a request', () => {
    expect(getContext()).toBeUndefined();
  });

  it('carries requestId and a later callId through async work', async () => {
    await runWithContext({ requestId: 'req-1' }, async () => {
      await Promise.resolve();
      setCallId('call-9');
      await new Promise((r) => setTimeout(r, 1));
      expect(getContext()).toEqual({ requestId: 'req-1', callId: 'call-9' });
    });
  });

  it('keeps concurrent requests apart', async () => {
    const seen: string[] = [];
    await Promise.all(
      ['a', 'b', 'c'].map((id) =>
        runWithContext({ requestId: id }, async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 5));
          seen.push(getContext()!.requestId);
        }),
      ),
    );
    expect(seen.sort()).toEqual(['a', 'b', 'c']);
  });
});

describe('job context propagation', () => {
  it('adds requestId and callId to job data', () => {
    const data = runWithContext({ requestId: 'req-2', callId: 'call-1' }, () =>
      withJobContext({ foo: 1 }),
    );
    expect(data).toEqual({ foo: 1, [JOB_CONTEXT_KEY]: { requestId: 'req-2', callId: 'call-1' } });
  });
});

describe('logger redaction', () => {
  it('redacts secrets and keeps the correlation fields', () => {
    const lines: string[] = [];
    const sink = new Writable({
      write(chunk, _enc, cb) {
        lines.push(chunk.toString());
        cb();
      },
    });
    const log = pino(
      {
        redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
        mixin: () => ({ requestId: getContext()?.requestId, callId: getContext()?.callId }),
      },
      sink,
    );

    runWithContext({ requestId: 'req-3', callId: 'call-3' }, () => {
      log.info(
        {
          req: { headers: { authorization: 'Bearer abc', cookie: 'sid=1' } },
          user: { password: 'hunter2', otp: '123456', token: 'tkn' },
        },
        'hello',
      );
    });

    const out = JSON.parse(lines[0]);
    expect(out.requestId).toBe('req-3');
    expect(out.callId).toBe('call-3');
    expect(out.req.headers.authorization).toBe('[REDACTED]');
    expect(out.req.headers.cookie).toBe('[REDACTED]');
    expect(out.user.password).toBe('[REDACTED]');
    expect(out.user.otp).toBe('[REDACTED]');
    expect(out.user.token).toBe('[REDACTED]');
    expect(lines[0]).not.toContain('hunter2');
  });
});
