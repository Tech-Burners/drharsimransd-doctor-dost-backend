
import { Model, Types } from 'mongoose';

export type TResearchConsentStatus = 'granted' | 'revoked';

export interface TResearchConsent {
  userId: Types.ObjectId;

  version: string;
  purpose: string;
  wording: string;

  status: TResearchConsentStatus;

  consentedAt: Date;
  revokedAt: Date | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type ResearchConsentModel = Model<TResearchConsent>;
