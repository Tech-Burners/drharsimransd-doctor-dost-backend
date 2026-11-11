# Testing

Jest with ts-jest. Run everything with `npm test`.

| Script | What it runs |
|---|---|
| `npm test` | every suite |
| `npm run test:unit` | files **not** named `*.int.test.ts` (no database) |
| `npm run test:integration` | files named `*.int.test.ts` (real replica-set database) |

## The split

**Money paths are INTEGRATION tests against a real database. Everything else may be a unit
test. A mocked transaction proves nothing.**

- Integration (`*.int.test.ts`): anything that touches a Mongo transaction, a write
  concern, a unique index, or the ledger. That is call start, call end, top-up credit,
  prescription submit, withdrawal request, the short-call allowance, and the idempotency
  middleware. Phases 5, 6 and 7 are written this way.
- Unit (`*.test.ts`): pure functions and wiring. Billing arithmetic, the IST window helper,
  zod schemas, log redaction, the app shell.

Do not mock `mongoose`, sessions or `withTransaction` in a money test.

## The test database

`mongodb-memory-server` in **replica set** mode (one node), never standalone. Transactions
need a replica set, and write concerns and unique-index violations behave differently on a
standalone mongod. The first run downloads a mongod binary, so it is slow once.

```ts
import { useTestDb } from '../test/helpers/db';

describe('something with money', () => {
  const db = useTestDb();   // starts the replica set once per suite, truncates after each test

  it('...', async () => {
    const session = await db.startSession();
    await session.withTransaction(async () => { /* ... */ }, {
      readConcern: { level: 'snapshot' },
      writeConcern: { w: 'majority' },
    });
    await session.endSession();
  });
});
```

Notes:

- Mongoose needs `{ ordered: true }` to create several documents in one session.
- Indexes are built up front and survive truncation, so unique-index tests behave as in
  production.
- `src/test/setupEnv.ts` blanks `DATABASE_URL`, `REDIS_URL` and `SENTRY_DSN` before every
  file, so a test can never reach a real service through a developer `.env`.

## The smoke test

`src/test/smoke.transaction.int.test.ts` opens a session, writes two documents, aborts, and
asserts neither persisted. If it cannot pass, nothing in Phase 5 onwards can be trusted.

## Type checking

`ts-jest` reports type errors as warnings. `npm run build` (`tsc`) is the type gate.

## Real Redis tests (optional)

`src/shared/rateLimit.redis.int.test.ts`, `src/app/modules/outbox/outbox.worker.int.test.ts` and `src/app/modules/call/call.redis.int.test.ts` run against a real Redis only when `TEST_REDIS_URL` is set; otherwise those tests skip. Point it ONLY at a throwaway instance: the database is flushed before each test.

    docker run -d --rm --name dd-test-redis -p 6390:6379 redis:7
    TEST_REDIS_URL=redis://localhost:6390 npm test
    docker stop dd-test-redis
