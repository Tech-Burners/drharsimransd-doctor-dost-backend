
import { model, Schema } from 'mongoose';
import {
  TWithdrawalRequest,
  WithdrawalRequestModel,
} from './withdrawalRequest.interface';
import {
  WITHDRAWAL_DESTINATION_TYPE,
  WITHDRAWAL_REQUEST_STATUS,
} from './withdrawalRequest.constants';

const withdrawalRequestSchema = new Schema<
  TWithdrawalRequest,
  WithdrawalRequestModel
>(
  {
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: 'Doctor',
      required: true,
    },
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Withdrawal amount must be a safe integer in paise',
      },
    },
    destinationType: {
      type: String,
      enum: Object.values(WITHDRAWAL_DESTINATION_TYPE),
      required: true,
    },
    destinationSnapshot: {
      type: Schema.Types.Mixed,
      required: true,
    },
    status: {
      type: String,
      enum: Object.values(WITHDRAWAL_REQUEST_STATUS),
      default: WITHDRAWAL_REQUEST_STATUS.PENDING,
      required: true,
    },
    referenceNo: {
      type: String,
      trim: true,
      default: null,
    },
    rejectionReason: {
      type: String,
      trim: true,
      default: null,
    },
    decidedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    decidedAt: {
      type: Date,
      default: null,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
      required: true,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

// Retrieve a doctor's withdrawal history.
withdrawalRequestSchema.index({ doctorId: 1, requestedAt: -1 });

// Retrieve requests by status for admin review.
withdrawalRequestSchema.index({ status: 1, requestedAt: 1 });

export const WithdrawalRequest = model<
  TWithdrawalRequest,
  WithdrawalRequestModel
>('WithdrawalRequest', withdrawalRequestSchema);
