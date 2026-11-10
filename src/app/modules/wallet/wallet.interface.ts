import { Model, Types } from 'mongoose';

export interface TWallet {
  userId: Types.ObjectId;
  // Integer paise; never negative.
  balancePaise: number;
  // The newest WalletLedger entry reflected in balancePaise.
  lastLedgerEntryId: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type WalletModel = Model<TWallet>;
