import { Model, Types } from 'mongoose';

export type TVerificationStatus =
  | 'pending'
  | 'approved'
  | 'rejected';

export type TVerificationRejectionReason =
  | 'illegible_document'
  | 'details_mismatch'
  | 'invalid_registration'
  | 'expired_registration'
  | 'other';

export interface TDoctorVerification {
  doctorId: Types.ObjectId;

  certificatePath: string;

  submittedAt: Date;


  attemptNo: number;

  rejectionReason: TVerificationRejectionReason | null;
  rejectionNote: string | null;
  resubmissionAllowed: boolean;

  reviewedBy: Types.ObjectId | null;

  reviewedAt: Date | null;

  status: TVerificationStatus;

  isDeleted: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type DoctorVerificationModel =
  Model<TDoctorVerification>;