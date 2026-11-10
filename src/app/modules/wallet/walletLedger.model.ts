
import { model, Schema } from 'mongoose';
import {
  TWalletLedger,
  WalletLedgerModel,
} from './walletLedger.interface';
import {
  WALLET_LEDGER_DIRECTION,
  WALLET_LEDGER_TYPE,
} from './walletLedger.constants';

const walletLedgerSchema = new Schema<
  TWalletLedger,
  WalletLedgerModel
>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    walletId: {
      type: Schema.Types.ObjectId,
      ref: 'Wallet',
      required: true,
    },
    type: {
      type: String,
      enum: Object.values(WALLET_LEDGER_TYPE),
      required: true,
    },
    direction: {
      type: String,
      enum: Object.values(WALLET_LEDGER_DIRECTION),
      required: true,
    },
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Amount must be a safe integer in paise',
      },
    },
    balanceAfterPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Balance must be a safe integer in paise',
      },
    },
    idempotencyKey: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    referenceId: {
      type: Schema.Types.ObjectId,
      default: null,
    },
    referenceType: {
      type: String,
      default: '',
    },
    description: {
      type: String,
      default: '',
    },
    metadata: {
      type: Schema.Types.Mixed,
      default: {},
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

walletLedgerSchema.index({ userId: 1, createdAt: -1 });
walletLedgerSchema.index({ userId: 1, type: 1, createdAt: -1 });

export const WalletLedger = model<
  TWalletLedger,
  WalletLedgerModel
>('WalletLedger', walletLedgerSchema);
