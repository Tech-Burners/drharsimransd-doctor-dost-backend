import { Model } from 'mongoose';

export type TReceiverType = 'email' | 'phone';
export type TPurposeType =
  | 'email-verification'
  | 'reset-password'
  | 'phone-verification';
export type TStatus = 'pending' | 'verified' | 'expired';

export interface CreateOtpParams {
  name: string;
  sentTo: string;
  receiverType: TReceiverType;
  purpose: TPurposeType;
  otp: string;
  expiredAt: string;
}

export interface TOtp {
  sentTo: string;
  receiverType: TReceiverType;
  purpose: TPurposeType;
  // bcrypt hash of the code, never the plain code
  otp: string;
  expiredAt: Date;
  status: TStatus;
  attempts: number;
  maxAttempts: number;
}

export interface OtpModel extends Model<TOtp> {
  isOtpMatched(plainOtp: string, hashedOtp: string): Promise<boolean>;
}
