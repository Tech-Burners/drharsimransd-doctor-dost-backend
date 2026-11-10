import { Model, Types } from 'mongoose';

export type TRecordingAccessRole = 'patient' | 'doctor' | 'admin';
export type TRecordingAccessAction = 'view' | 'download';
export type TRecordingAccessReason =
  | 'patient_complaint'
  | 'medico_legal'
  | 'quality_audit'
  | 'other';

export interface TRecordingAccessLog {
  callId: Types.ObjectId;
  accessedBy: Types.ObjectId;
  accessedAs: TRecordingAccessRole;
  action: TRecordingAccessAction;
  reason: TRecordingAccessReason;
  reasonNote: string;
  objectKey: string;
  ipAddress: string;
  userAgent: string;
  accessedAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}
export type RecordingAccessLogModel = Model<TRecordingAccessLog>;
