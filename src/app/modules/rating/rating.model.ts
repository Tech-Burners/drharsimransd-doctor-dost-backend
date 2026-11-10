import { model, Schema } from 'mongoose';
import { TRating, RatingModel } from './rating.interface';
import { RATING_PATIENT_DISPLAY } from './rating.constants';

const ratingSchema = new Schema<TRating>(
  {
    callId: {
      type: Schema.Types.ObjectId,
      ref: 'Call',
      required: true,
      unique: true,
    },
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
    stars: {
      type: Number,
      required: true,
      min: 1,
      max: 5,
    },
    comment: {
      type: String,
      default: '',
    },
    isPublic: {
      type: Boolean,
      default: true,
    },
    patientDisplay: {
      type: String,
      enum: Object.values(RATING_PATIENT_DISPLAY),
      default: RATING_PATIENT_DISPLAY.NAME,
    },
    hiddenBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    hiddenReason: {
      type: String,
      default: null,
    },
    hiddenAt: {
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

ratingSchema.index({ doctorId: 1, createdAt: -1 });

export const Rating = model<TRating, RatingModel>('Rating', ratingSchema);
