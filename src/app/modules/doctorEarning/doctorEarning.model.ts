
import { model, Schema } from 'mongoose';
import {
  TDoctorEarning,
  DoctorEarningModel,
} from './doctorEarning.interface';
import { DOCTOR_EARNING_STATUS } from './doctorEarning.constants';

const doctorEarningSchema = new Schema<TDoctorEarning>(
  {
    callId: {
      type: Schema.Types.ObjectId,
      ref: 'Call',
      required: true,
      unique: true,
    },

    doctorId: {
      type: Schema.Types.ObjectId,
      ref: 'Doctor',
      required: true,
    },

    grossPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Gross amount must be a safe integer',
      },
    },

    commissionPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Commission must be a safe integer',
      },
    },

    netPaise: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Net amount must be a safe integer',
      },
    },

    deductionPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Deduction must be a safe integer',
      },
    },

    deductionType: {
      type: String,
      default: null,
      trim: true,
    },

    status: {
      type: String,
      enum: Object.values(DOCTOR_EARNING_STATUS),
      default: DOCTOR_EARNING_STATUS.HELD,
      required: true,
    },

    heldAt: {
      type: Date,
      default: Date.now,
      required: true,
    },

    releasedAt: {
      type: Date,
      default: null,
    },

    forfeitedAt: {
      type: Date,
      default: null,
    },

    withdrawalRequestId: {
      type: Schema.Types.ObjectId,
      ref: 'WithdrawalRequest',
      default: null,
    },

    // --- Refund reversal and recovery (client decisions 25 to 27) ---------------------
    reversedAt: {
      type: Date,
      default: null,
    },
    // What the doctor already received and now owes back. 0 unless the earning had been
    // paid out (or sat in a request already being paid). Existing rows default to 0.
    recoveryPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'recoveryPaise must be a safe integer' },
    },
    recoveredPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'recoveredPaise must be a safe integer' },
    },
    writtenOffPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: { validator: Number.isSafeInteger, message: 'writtenOffPaise must be a safe integer' },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

// Indexes
doctorEarningSchema.index({
  doctorId: 1,
  status: 1,
  withdrawalRequestId: 1,
});

doctorEarningSchema.index({
  withdrawalRequestId: 1,
});

// Find a doctor's open recoveries quickly. Partial: most rows never owe anything.
doctorEarningSchema.index(
  { doctorId: 1, reversedAt: 1 },
  { partialFilterExpression: { recoveryPaise: { $gt: 0 } } },
);

// Money-shape guards. A reversed row must say when, and recovery can never be over-applied.
doctorEarningSchema.pre('validate', function (next) {
  if (this.status === DOCTOR_EARNING_STATUS.REVERSED && !this.reversedAt) {
    this.invalidate('reversedAt', 'reversedAt is required when status is reversed');
  }
  if (this.recoveredPaise + this.writtenOffPaise > this.recoveryPaise) {
    this.invalidate('recoveredPaise', 'recovered plus written off cannot exceed recoveryPaise');
  }
  if (this.recoveryPaise > this.netPaise) {
    this.invalidate('recoveryPaise', 'recoveryPaise cannot exceed the net earning');
  }
  next();
});

export const DoctorEarning = model<
  TDoctorEarning,
  DoctorEarningModel
>('DoctorEarning', doctorEarningSchema);
