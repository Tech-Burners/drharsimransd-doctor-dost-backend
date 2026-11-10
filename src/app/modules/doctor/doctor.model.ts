
import { model, Schema } from 'mongoose';
import { TDoctor, DoctorModel } from './doctor.interface';
import {
  DOCTOR_APPROVAL_STATUS,
  DOCTOR_PAYOUT_MODE,
  DOCTOR_SPECIALTY,
} from './doctor.constants';
import { softDeletePlugin } from '../../plugins/softDelete.plugin';

const doctorSchema = new Schema<TDoctor>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },

    bio: {
      type: String,
      default: '',
    },
    qualification: {
      type: String,
      default: '',
    },
    specialty: {
      type: String,
      enum: [...Object.values(DOCTOR_SPECIALTY), null],
      default: null,
    },

    registrationNumber: {
      type: String,
      trim: true,
      default: '',
    },
    medicalCouncil: {
      type: String,
      trim: true,
      default: '',
    },

    experienceYears: {
      type: Number,
      default: 0,
      min: 0,
    },

    certificatePath: {
      type: String,
      default: '',
    },
    signaturePath: {
      type: String,
      default: '',
    },

    consultationRateDayPaise: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (v: number | null) => v === null || Number.isSafeInteger(v),
        message: 'Day consultation rate must be a safe integer',
      },
    },
    consultationRateNightPaise: {
      type: Number,
      default: null,
      min: 0,
      validate: {
        validator: (v: number | null) => v === null || Number.isSafeInteger(v),
        message: 'Night consultation rate must be a safe integer',
      },
    },
    rateUpdatedAt: {
      type: Date,
      default: null,
    },

    approvalStatus: {
      type: String,
      enum: Object.values(DOCTOR_APPROVAL_STATUS),
      default: DOCTOR_APPROVAL_STATUS.PENDING,
    },

    // CACHE of Redis presence, refreshed by the presence sweep. Kept as a Mongo field
    // so the patient doctor list can filter and sort on it. Never the source of truth;
    // nothing writes it on every heartbeat. See Phase 6 and Phase 8.
    isOnline: {
      type: Boolean,
      default: false,
    },
    lastOnlineAt: {
      type: Date,
      default: null,
    },

    commissionPercent: {
      type: Number,
      default: null,
      min: 0,
      max: 100,
    },
    payoutMode: {
      type: String,
      enum: Object.values(DOCTOR_PAYOUT_MODE),
      default: DOCTOR_PAYOUT_MODE.COMMISSION,
    },

    bankAccountName: {
      type: String,
      trim: true,
      default: null,
    },
    bankAccountNumber: {
      type: String,
      trim: true,
      default: null,
    },
    bankName: {
      type: String,
      trim: true,
      default: null,
    },
    bankIfsc: {
      type: String,
      trim: true,
      default: null,
    },

    upiId: {
      type: String,
      trim: true,
      default: null,
    },
    preferredPayout: {
      type: String,
      enum: ['bank', 'upi', null],
      default: null,
    },
    pan: {
      type: String,
      trim: true,
      default: null,
      select: false,
    },

    languagesSpoken: {
      type: [String],
      default: [],
    },
    conditionsTreated: {
      type: [String],
      default: [],
    },

    isAvailableForUrgentCalls: {
      type: Boolean,
      default: false,
    },

    ratingAvg: {
      type: Number,
      default: 0,
      min: 0,
      max: 5,
    },
    ratingCount: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Rating count must be a safe integer',
      },
    },

    isDeleted: {
      type: Boolean,
      default: false,
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
doctorSchema.index({ approvalStatus: 1, isOnline: 1 });
doctorSchema.index({ isDeleted: 1, approvalStatus: 1, isOnline: 1 });
doctorSchema.index({ approvalStatus: 1, ratingAvg: -1 });

// A doctor cannot go online until both consultation rates are set.
doctorSchema.pre('validate', function (next) {
  if (
    this.isOnline &&
    (this.consultationRateDayPaise == null ||
      this.consultationRateNightPaise == null)
  ) {
    this.invalidate(
      'isOnline',
      'Set both day and night consultation rates before going online',
    );
  }
  next();
});

// Exclude soft-deleted doctors from queries and aggregations.
doctorSchema.plugin(softDeletePlugin);

export const Doctor = model<TDoctor, DoctorModel>(
  'Doctor',
  doctorSchema,
);
