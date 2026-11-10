
import { Model, Types } from 'mongoose';

export type TNotificationType =
  | 'new_doctor_joined'
  | 'new_patient_joined'
  | 'call'
  | 'payment'
  | 'withdrawal'
  | 'prescription'
  | 'verification'
  | 'system';

export interface TNotification {
  userId: Types.ObjectId;
  type: TNotificationType;
  title: string;
  body: string;
  data: Record<string, unknown>;
  readAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type NotificationModel = Model<TNotification>;
