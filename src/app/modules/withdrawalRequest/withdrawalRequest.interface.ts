
import { Model, Types } from 'mongoose';

export type TWithdrawalDestinationType = 'bank' | 'upi';

export type TWithdrawalRequestStatus =
  | 'pending'
  | 'paid'
  | 'rejected'
  | 'cancelled';

export interface TWithdrawalRequest {
  doctorId: Types.ObjectId;

  amountPaise: number;

  destinationType: TWithdrawalDestinationType;
  destinationSnapshot: Record<string, unknown>;

  status: TWithdrawalRequestStatus;

  referenceNo: string | null;
  rejectionReason: string | null;

  decidedBy: Types.ObjectId | null;
  decidedAt: Date | null;

  requestedAt: Date;

  createdAt?: Date;
  updatedAt?: Date;
}

export type WithdrawalRequestModel = Model<TWithdrawalRequest>;
