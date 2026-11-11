// Test database helper.
//
// A one-node REPLICA SET, not a standalone mongod: transactions, write concerns and
// unique-index violations all behave differently on a standalone, and those are exactly
// what the money tests exercise.
//
// Usage in a suite:
//
//   const db = useTestDb();            // starts once per suite, truncates after each test
//   it('...', async () => {
//     const session = await db.startSession();
//     await session.withTransaction(async () => { ... });
//     await session.endSession();
//   });
import { ClientSession } from 'mongoose';
import mongoose from 'mongoose';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

export interface TestDb {
  /** Opens a new session. The caller ends it. */
  startSession: () => Promise<ClientSession>;
  /** Deletes every document in every collection. Indexes are kept. */
  truncate: () => Promise<void>;
  uri: () => string;
}

export const useTestDb = (): TestDb => {
  let replSet: MongoMemoryReplSet | undefined;

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger' },
    });
    await mongoose.connect(replSet.getUri(), { serverSelectionTimeoutMS: 20000 });
    // Build every model index up front so unique-index tests behave like production.
    await Promise.all(Object.values(mongoose.models).map((m) => m.init()));
  });

  afterEach(async () => {
    await truncate();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await replSet?.stop();
  });

  const truncate = async (): Promise<void> => {
    const collections = await mongoose.connection.db!.collections();
    await Promise.all(collections.map((c) => c.deleteMany({})));
  };

  return {
    startSession: () => mongoose.startSession(),
    truncate,
    uri: () => {
      if (!replSet) throw new Error('Test database is not started');
      return replSet.getUri();
    },
  };
};
