
import { model, Schema } from 'mongoose';
import {
  TPaymentOrder,
  PaymentOrderModel,
} from './paymentOrder.interface';
import { PAYMENT_ORDER_STATUS } from './paymentOrder.constants';

const paymentOrderSchema = new Schema<
  TPaymentOrder,
  PaymentOrderModel
>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
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
    razorpayOrderId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    razorpayPaymentId: {
      type: String,
      default: null,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(PAYMENT_ORDER_STATUS),
      default: PAYMENT_ORDER_STATUS.CREATED,
      required: true,
    },
    signatureVerified: {
      type: Boolean,
      default: false,
      required: true,
    },
    walletId: {
      type: Schema.Types.ObjectId,
      ref: 'Wallet',
      required: true,
    },
    ledgerEntryId: {
      type: Schema.Types.ObjectId,
      ref: 'WalletLedger',
      default: null,
    },
    paidAt: {
      type: Date,
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

// Retrieve a user's payment history.
paymentOrderSchema.index({ userId: 1, createdAt: -1 });

// Find payments by wallet.
paymentOrderSchema.index({ walletId: 1, createdAt: -1 });

// Prevent the same Razorpay payment ID from being assigned
// to multiple payment orders.
paymentOrderSchema.index(
  { razorpayPaymentId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      razorpayPaymentId: { $type: 'string' },
    },
  },
);

export const PaymentOrder = model<
  TPaymentOrder,
  PaymentOrderModel
>('PaymentOrder', paymentOrderSchema);
