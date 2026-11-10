
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

export const DoctorEarning = model<
  TDoctorEarning,
  DoctorEarningModel
>('DoctorEarning', doctorEarningSchema);
