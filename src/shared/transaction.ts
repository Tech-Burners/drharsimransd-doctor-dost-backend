// Money transactions. CLAUDE.md: writeConcern { w: 'majority' }, readConcern 'snapshot',
// wrapped in a retry on TransientTransactionError.
//
// The driver's withTransaction() IS that retry: it re-runs the callback on a
// TransientTransactionError (for example a WriteConflict between two concurrent wallet
// appends) and re-attempts an unknown commit result, for up to 120 seconds. The callback
// therefore must touch only the database inside the session, never an external service.
//
// If a transaction throws because of the topology (standalone mongod), fix the topology.
// Never remove the session to silence it.
import mongoose, { ClientSession } from 'mongoose';

export const runInTransaction = async <T>(fn: (session: ClientSession) => Promise<T>): Promise<T> => {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(
      async () => {
        result = await fn(session);
      },
      { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' } },
    );
    return result;
  } finally {
    await session.endSession();
  }
};
