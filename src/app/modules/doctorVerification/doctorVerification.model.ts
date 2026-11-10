import { model, Schema } from 'mongoose';
import {
  TDoctorVerification,
  DoctorVerificationModel,
} from './doctorVerification.interface';
import {
  VERIFICATION_REJECTION_REASON,
  VERIFICATION_STATUS,
} from './doctorVerification.constants';
import { softDeletePlugin } from '../../plugins/softDelete.plugin';

const doctorVerificationSchema = new Schema<TDoctorVerification>(
    {
      doctorId: {
        type: Schema.Types.ObjectId,
        ref: 'Doctor',
        required: true,
      },

      certificatePath: {
        type: String,
        required: true,
        trim: true,
      },

      submittedAt: {
        type: Date,
        default: Date.now,
      },


      attemptNo: {
        type: Number,
        default: 1,
        min: 1,
        validate: {
          validator: Number.isSafeInteger,
          message: 'Attempt number must be a valid integer',
        },
      },

      rejectionReason: {
        type: String,
        enum: [...Object.values(VERIFICATION_REJECTION_REASON), null],
        default: null,
      },

      resubmissionAllowed: {
        type: Boolean,
        default: true,
      },
      rejectionNote: {
        type: String,
        default: null,
        trim: true,
      },
      reviewedBy: {
        type: Schema.Types.ObjectId,
        ref: 'User',
        default: null,
      },

      reviewedAt: {
        type: Date,
        default: null,
      },

      status: {
        type: String,
        enum: Object.values(VERIFICATION_STATUS),
        default: VERIFICATION_STATUS.PENDING,
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
doctorVerificationSchema.index({
  doctorId: 1,
  status: 1,
});

// Each submission attempt of a doctor is unique.
doctorVerificationSchema.index(
  {
    doctorId: 1,
    attemptNo: 1,
  },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);

// Exclude soft-deleted documents from queries and aggregations
doctorVerificationSchema.plugin(softDeletePlugin);

export const DoctorVerification = model<
  TDoctorVerification,
  DoctorVerificationModel
>('DoctorVerification', doctorVerificationSchema);