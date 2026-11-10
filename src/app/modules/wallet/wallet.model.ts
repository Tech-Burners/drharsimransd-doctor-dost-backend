// WalletLedger is the authoritative record of every balance change.
// This document is only a cache of the current balance, written in the same
// transaction as the ledger entry. Never read it to make a decision
// (e.g. whether a call or withdrawal is affordable); derive that from the ledger.
import { model, Schema } from 'mongoose';
import { TWallet, WalletModel } from './wallet.interface';

const walletSchema = new Schema<TWallet, WalletModel>(
  {
    // One wallet per user (one-to-one).
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    balancePaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Balance must be a safe integer in paise',
      },
    },
    lastLedgerEntryId: {
      type: Schema.Types.ObjectId,
      ref: 'WalletLedger',
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

export const Wallet = model<TWallet, WalletModel>('Wallet', walletSchema);
