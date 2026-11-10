
import { Model, Types } from 'mongoose';

export type TWalletLedgerType =
  | 'topup'
  | 'call_charge'
  | 'refund'
  | 'adjustment'
  | 'withdrawal';

export type TWalletLedgerDirection = 'credit' | 'debit';

export interface TWalletLedger {
  userId: Types.ObjectId;
  walletId: Types.ObjectId;
  type: TWalletLedgerType;
  direction: TWalletLedgerDirection;
  amountPaise: number;
  balanceAfterPaise: number;
  idempotencyKey: string;
  referenceId: Types.ObjectId | null;
  referenceType: string;
  description: string;
  metadata: Record<string, unknown>;
  createdAt?: Date;
  updatedAt?: Date;
}

export type WalletLedgerModel = Model<TWalletLedger>;
