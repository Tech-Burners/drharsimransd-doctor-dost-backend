
import { Model, Types } from 'mongoose';

export type TPaymentOrderStatus =
  | 'created'
  | 'paid'
  | 'failed'
  | 'cancelled';

export interface TPaymentOrder {
  userId: Types.ObjectId;
  amountPaise: number;

  razorpayOrderId: string;
  razorpayPaymentId: string | null;

  status: TPaymentOrderStatus;
  signatureVerified: boolean;

  walletId: Types.ObjectId;
  ledgerEntryId: Types.ObjectId | null;
  paidAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type PaymentOrderModel = Model<TPaymentOrder>;
