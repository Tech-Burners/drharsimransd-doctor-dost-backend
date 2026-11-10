
import { Model, Types } from 'mongoose';

export type TDoctorApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'suspended';

export type TDoctorPayoutMode = 'commission' | 'retainer';

export type TPreferredPayout = 'bank' | 'upi';

export type TDoctorSpecialty =
  | 'general_physician'
  | 'pediatrician'
  | 'gynecologist'
  | 'dermatologist'
  | 'cardiologist'
  | 'orthopedic'
  | 'psychiatrist'
  | 'neurologist'
  | 'ent'
  | 'ophthalmologist'
  | 'urologist'
  | 'dentist'
  | 'other';

export interface TDoctor {
  userId: Types.ObjectId;

  bio: string;
  qualification: string;
  specialty: TDoctorSpecialty | null;

  registrationNumber: string;
  medicalCouncil: string;

  experienceYears: number;
  certificatePath: string;
  signaturePath: string;

  // null until the doctor sets them; a doctor cannot go online without both.
  consultationRateDayPaise: number | null;
  consultationRateNightPaise: number | null;
  rateUpdatedAt: Date | null;

  approvalStatus: TDoctorApprovalStatus;
  isOnline: boolean;
  lastOnlineAt: Date | null;

  // null => fall back to PlatformSetting.commissionPct
  commissionPercent: number | null;
  payoutMode: TDoctorPayoutMode;

  bankAccountName: string | null;
  bankAccountNumber: string | null;
  bankName: string | null;
  bankIfsc: string | null;

  upiId: string | null;
  preferredPayout: TPreferredPayout | null;
  pan: string | null;

  languagesSpoken: string[];
  conditionsTreated: string[];
  isAvailableForUrgentCalls: boolean;

  ratingAvg: number;
  ratingCount: number;

  isDeleted: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type DoctorModel = Model<TDoctor>;
