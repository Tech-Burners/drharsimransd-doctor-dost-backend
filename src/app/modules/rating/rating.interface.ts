import { Model, Types } from 'mongoose';

export interface TRating {
  callId: Types.ObjectId;
  patientId: Types.ObjectId;
  doctorId: Types.ObjectId;
  stars: number;
  comment: string;
  isPublic: boolean;
  patientDisplay: 'name' | 'initials' | 'anonymous';
  hiddenBy: Types.ObjectId | null;
  hiddenReason: string | null;
  hiddenAt: Date | null;
  createdAt?: Date;
  updatedAt?: Date;
}
export type RatingModel = Model<TRating>;
