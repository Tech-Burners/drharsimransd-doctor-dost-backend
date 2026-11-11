// Smoke test for the test harness itself. If this cannot pass, nothing in Phase 5
// onwards can be trusted: it proves the database really is a replica set that supports
// transactions, and that an aborted transaction leaves nothing behind.
import mongoose, { Schema } from 'mongoose';
import { useTestDb } from './helpers/db';

const Thing = mongoose.model('SmokeThing', new Schema({ name: String }));

describe('test harness: transactions', () => {
  const db = useTestDb();

  it('rolls back both writes when the transaction is aborted', async () => {
    const session = await db.startSession();
    try {
      session.startTransaction({
        readConcern: { level: 'snapshot' },
        writeConcern: { w: 'majority' },
      });
      await Thing.create([{ name: 'first' }], { session });
      await Thing.create([{ name: 'second' }], { session });
      // Visible inside the transaction...
      expect(await Thing.countDocuments({}).session(session)).toBe(2);
      await session.abortTransaction();
    } finally {
      await session.endSession();
    }

    // ...and gone afterwards.
    expect(await Thing.countDocuments({})).toBe(0);
  });

  it('commits both writes when the transaction commits', async () => {
    const session = await db.startSession();
    try {
      await session.withTransaction(
        async () => {
          await Thing.create([{ name: 'a' }, { name: 'b' }], { session, ordered: true });
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
      );
    } finally {
      await session.endSession();
    }
    expect(await Thing.countDocuments({})).toBe(2);
  });

  it('truncates between tests', async () => {
    expect(await Thing.countDocuments({})).toBe(0);
  });
});
