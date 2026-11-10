import { Model, Types } from 'mongoose';

export type TDoctorEarningStatus =
  | 'held'
  | 'released'
  | 'forfeited'
  | 'withdrawn';

export interface TDoctorEarning {
  callId: Types.ObjectId;
  doctorId: Types.ObjectId;
  grossPaise: number;
  commissionPaise: number;
  netPaise: number;
  deductionPaise: number;
  deductionType: string | null;
  status: TDoctorEarningStatus;
  heldAt: Date;
  releasedAt: Date | null;
  forfeitedAt: Date | null;
  withdrawalRequestId: Types.ObjectId | null;
  createdAt?: Date;
  updatedAt?: Date;
}
export type DoctorEarningModel = Model<TDoctorEarning>;
