import { Model, Types } from 'mongoose';

export interface TShortCallAllowance {
  patientId: Types.ObjectId;
  doctorId: Types.ObjectId;
  callId: Types.ObjectId;
  consumedAt: Date;
}

export type ShortCallAllowanceModel = Model<TShortCallAllowance>;
