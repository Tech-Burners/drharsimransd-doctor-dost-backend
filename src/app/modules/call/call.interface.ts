
import { Model, Types } from 'mongoose';

export type TCallStatus =
  | 'ringing'
  | 'rejected'
  | 'missed'
  | 'active'
  | 'completed'
  | 'ended_low_balance'
  | 'failed';

export type TCallEndReason =
  | 'patient_ended'
  | 'doctor_ended'
  | 'low_balance'
  | 'doctor_rejected'
  | 'patient_missed'
  | 'doctor_missed'
  | 'system_timeout'
  | 'system_error'
  | 'no_end_event';

export type TCallTimeSlot = 'day' | 'night';

export type TPrescriptionStatus =
  | 'pending'
  | 'submitted'
  | 'expired'
  | 'not_required';

export interface TCall {
  patientId: Types.ObjectId;
  doctorId: Types.ObjectId;

  status: TCallStatus;
  endReason: TCallEndReason | null;

  // Snapshot of the applicable rate at call initiation
  timeSlot: TCallTimeSlot;
  isUrgent: boolean;
  ratePaisePerMin: number;
  maxAffordableSeconds: number;

  // Call lifecycle
  startedAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;

  durationSeconds: number;
  billedMinutes: number;

  // Explicit flag: a sub-60s call that was billed 1 minute must read as charged,
  // so this is never derived from grossPaise === 0.
  isFreeShortCall: boolean;

  // All monetary amounts are integer paise
  // Commission % applied to this call, frozen when the call starts
  commissionPercentSnapshot: number;
  grossPaise: number;
  commissionPaise: number;
  netPaise: number;

  // Agora
  agoraChannelName: string;
  agoraUidPatient: string;
  agoraUidDoctor: string;

  // Prescription
  prescriptionStatus: TPrescriptionStatus;
  prescriptionDeadlineAt: Date | null;
  prescriptionSubmittedAt: Date | null;

  // Patient attachments
  photosByPatient: string[];

  // Recording
  recordingPath: string | null;
  isRecordingAvailable: boolean;

  createdAt?: Date;
  updatedAt?: Date;
}

export type CallModel = Model<TCall>;
