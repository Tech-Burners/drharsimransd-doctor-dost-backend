
import { model, Schema } from 'mongoose';
import { TCall, CallModel } from './call.interface';
import {
  CALL_END_REASON,
  CALL_STATUS,
  CALL_TIME_SLOT,
  PRESCRIPTION_STATUS,
} from './call.constants';

const callSchema = new Schema<TCall>(
  {
    patientId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    doctorId: {
      type: Schema.Types.ObjectId,
      ref: 'Doctor',
      required: true,
    },

    status: {
      type: String,
      enum: Object.values(CALL_STATUS),
      default: CALL_STATUS.RINGING,
      required: true,
    },
    endReason: {
      type: String,
      enum: [...Object.values(CALL_END_REASON), null],
      default: null,
    },

    // Pricing snapshot
    timeSlot: {
      type: String,
      enum: Object.values(CALL_TIME_SLOT),
      required: true,
    },
    isUrgent: {
      type: Boolean,
      required: true,
      default: false,
    },
    ratePaisePerMin: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'ratePaisePerMin must be a safe integer',
      },
    },
    maxAffordableSeconds: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'maxAffordableSeconds must be a safe integer',
      },
    },

    // Agora
    agoraChannelName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    agoraUidPatient: {
      type: String,
      required: true,
    },
    agoraUidDoctor: {
      type: String,
      required: true,
    },

    // Call lifecycle
    startedAt: {
      type: Date,
      default: null,
    },
    answeredAt: {
      type: Date,
      default: null,
    },
    endedAt: {
      type: Date,
      default: null,
    },
    durationSeconds: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'durationSeconds must be a safe integer',
      },
    },
    billedMinutes: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'billedMinutes must be a safe integer',
      },
    },

    isFreeShortCall: {
      type: Boolean,
      default: false,
    },

    // Billing (integer paise)
    commissionPercentSnapshot: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
    },
    grossPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'grossPaise must be a safe integer',
      },
    },
    commissionPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'commissionPaise must be a safe integer',
      },
    },
    netPaise: {
      type: Number,
      default: 0,
      min: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'netPaise must be a safe integer',
      },
    },

    // Prescription
    prescriptionStatus: {
      type: String,
      enum: Object.values(PRESCRIPTION_STATUS),
      default: PRESCRIPTION_STATUS.PENDING,
      required: true,
    },
    prescriptionDeadlineAt: {
      type: Date,
      default: null,
    },
    prescriptionSubmittedAt: {
      type: Date,
      default: null,
    },

    // Patient attachments
    photosByPatient: {
      type: [String],
      default: [],
    },

    // Recording
    recordingPath: {
      type: String,
      default: null,
    },
    isRecordingAvailable: {
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

// Query indexes
callSchema.index({ patientId: 1, createdAt: -1 });
callSchema.index({ doctorId: 1, createdAt: -1 });
callSchema.index({ doctorId: 1, status: 1 });
callSchema.index({ status: 1, createdAt: -1 });
callSchema.index({ prescriptionStatus: 1, prescriptionDeadlineAt: 1 });
callSchema.index({
  doctorId: 1,
  prescriptionStatus: 1,
  prescriptionDeadlineAt: 1,
});

// Business constraint: a doctor and a patient can each be in only one
// in-flight (ringing / active) call at a time.
const IN_FLIGHT_CALL_STATUSES = [CALL_STATUS.RINGING, CALL_STATUS.ACTIVE];

callSchema.index(
  { doctorId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: IN_FLIGHT_CALL_STATUSES } },
  },
);
callSchema.index(
  { patientId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: IN_FLIGHT_CALL_STATUSES } },
  },
);

export const Call = model<TCall, CallModel>('Call', callSchema);
