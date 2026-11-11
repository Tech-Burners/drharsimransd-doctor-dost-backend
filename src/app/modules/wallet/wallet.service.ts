// WalletLedger is authoritative; Wallet.balancePaise is a display cache written in the
// same transaction as every ledger entry and never read to make a decision.
import httpStatus from 'http-status';
import { ClientSession, Types } from 'mongoose';
import AppError from '../../error/AppError';
import { Wallet } from './wallet.model';
import { WalletLedger } from './walletLedger.model';
import { WALLET_LEDGER_DIRECTION, WALLET_LEDGER_TYPE } from './walletLedger.constants';
import { TWalletLedgerDirection, TWalletLedgerType } from './walletLedger.interface';

type Id = string | Types.ObjectId;

export interface AppendInput {
  userId: Id;
  type: TWalletLedgerType;
  direction: TWalletLedgerDirection;
  amountPaise: number;
  /** Unique across the whole ledger. A duplicate is an E11000, which callers treat as "already done". */
  idempotencyKey: string;
  referenceType?: string;
  referenceId?: Id | null;
  description?: string;
  metadata?: Record<string, unknown>;
}

// Which direction each entry type may have. 'adjustment' is the only two-way type.
const ALLOWED_DIRECTION: Record<TWalletLedgerType, TWalletLedgerDirection[]> = {
  [WALLET_LEDGER_TYPE.TOPUP]: [WALLET_LEDGER_DIRECTION.CREDIT],
  [WALLET_LEDGER_TYPE.REFUND]: [WALLET_LEDGER_DIRECTION.CREDIT],
  [WALLET_LEDGER_TYPE.CALL_CHARGE]: [WALLET_LEDGER_DIRECTION.DEBIT],
  [WALLET_LEDGER_TYPE.WITHDRAWAL]: [WALLET_LEDGER_DIRECTION.DEBIT],
  [WALLET_LEDGER_TYPE.ADJUSTMENT]: [WALLET_LEDGER_DIRECTION.CREDIT, WALLET_LEDGER_DIRECTION.DEBIT],
};

/** The wallet for a user, created on first use. Safe under concurrent first use. */
const ensureWallet = async (userId: Id, session?: ClientSession) => {
  const upsert = () =>
    Wallet.findOneAndUpdate(
      { userId },
      { $setOnInsert: { userId, balancePaise: 0, lastLedgerEntryId: null } },
      { upsert: true, new: true, ...(session && { session }) },
    );
  try {
    return await upsert();
  } catch (err) {
    if ((err as { code?: number }).code !== 11000 || session) throw err;
    return upsert(); // lost the race on the unique userId index; the wallet now exists
  }
};

const newestEntry = (userId: Id, session?: ClientSession) =>
  WalletLedger.findOne({ userId })
    .sort({ createdAt: -1, _id: -1 })
    .select('balanceAfterPaise createdAt')
    .lean()
    .session(session ?? null);

/**
 * The balance, read from the newest ledger entry. This is the only balance used for any
 * decision. Pass the session when reading inside a transaction.
 */
const getBalance = async (userId: Id, session?: ClientSession): Promise<number> => {
  const last = await newestEntry(userId, session);
  return last ? last.balanceAfterPaise : 0;
};

/**
 * Append one ledger entry and update the cache, inside the CALLER's transaction.
 * Nothing is ever updated or deleted: a refund is a new credit, not a reversal.
 *
 * Concurrency: the first thing done is a write to the Wallet document. Two transactions
 * appending for the same user therefore conflict; the loser gets a TransientTransactionError,
 * its whole callback re-runs on a fresh snapshot, and it sees the winner's entry. Without
 * that write both would read the same "newest entry" and one credit or debit would be lost.
 */
const append = async (session: ClientSession, input: AppendInput) => {
  if (!session) throw new Error('walletService.append requires a session');
  if (!Number.isSafeInteger(input.amountPaise) || input.amountPaise < 1) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Amount must be a positive whole number of paise');
  }
  if (!ALLOWED_DIRECTION[input.type]?.includes(input.direction)) {
    throw new AppError(httpStatus.BAD_REQUEST, `A ${input.type} entry cannot be a ${input.direction}`);
  }

  const wallet = await ensureWallet(input.userId, session);

  // The lock write (see above). $currentDate always modifies, so it always conflicts.
  await Wallet.updateOne({ _id: wallet._id }, { $currentDate: { updatedAt: true } }, { session, timestamps: false });

  const last = await newestEntry(input.userId, session);
  const before = last ? last.balanceAfterPaise : 0;
  const after = input.direction === WALLET_LEDGER_DIRECTION.CREDIT ? before + input.amountPaise : before - input.amountPaise;

  if (after < 0) {
    throw new AppError(httpStatus.PAYMENT_REQUIRED, 'Insufficient wallet balance');
  }
  if (!Number.isSafeInteger(after)) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Balance out of range');
  }

  // Strictly later than the previous entry even if two app servers' clocks disagree, so
  // "newest entry" is unambiguous.
  const createdAt = new Date(Math.max(Date.now(), last ? new Date(last.createdAt as Date).getTime() + 1 : 0));

  const [entry] = await WalletLedger.create(
    [
      {
        userId: input.userId,
        walletId: wallet._id,
        type: input.type,
        direction: input.direction,
        amountPaise: input.amountPaise,
        balanceAfterPaise: after,
        idempotencyKey: input.idempotencyKey,
        referenceType: input.referenceType ?? '',
        referenceId: input.referenceId ?? null,
        description: input.description ?? '',
        metadata: input.metadata ?? {},
        createdAt,
      },
    ],
    { session },
  );

  await Wallet.updateOne(
    { _id: wallet._id },
    { $set: { balancePaise: after, lastLedgerEntryId: entry._id } },
    { session },
  );

  return entry;
};

/** GET /wallet: the ledger-derived balance plus one page of entries, newest first. */
const getWalletView = async (actor: { userId: string }, page: number, limit: number) => {
  const filter = { userId: actor.userId };
  const [balancePaise, total, entries] = await Promise.all([
    getBalance(actor.userId),
    WalletLedger.countDocuments(filter),
    WalletLedger.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .select('type direction amountPaise balanceAfterPaise referenceType referenceId description createdAt')
      .lean(),
  ]);
  return {
    balancePaise,
    ledger: entries,
    meta: { page, limit, total, totalPage: Math.max(1, Math.ceil(total / limit)) },
  };
};

export const walletService = { ensureWallet, getBalance, append, getWalletView };
