
import { model, Schema } from 'mongoose';
import {
  TResearchConsent,
  ResearchConsentModel,
} from './researchConsent.interface';
import { RESEARCH_CONSENT_STATUS } from './researchConsent.constants';

const researchConsentSchema = new Schema<
  TResearchConsent,
  ResearchConsentModel
>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    version: {
      type: String,
      required: true,
      trim: true,
    },
    purpose: {
      type: String,
      required: true,
      trim: true,
    },
    wording: {
      type: String,
      required: true,
      trim: true,
    },
    status: {
      type: String,
      enum: Object.values(RESEARCH_CONSENT_STATUS),
      default: RESEARCH_CONSENT_STATUS.GRANTED,
      required: true,
    },
    consentedAt: {
      type: Date,
      required: true,
      default: Date.now,
    },
    revokedAt: {
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

// Prevent duplicate records for the same user and consent version.
researchConsentSchema.index(
  { userId: 1, version: 1 },
  { unique: true },
);

// Retrieve a user's consent history.
researchConsentSchema.index({ userId: 1, createdAt: -1 });

export const ResearchConsent = model<
  TResearchConsent,
  ResearchConsentModel
>('ResearchConsent', researchConsentSchema);
