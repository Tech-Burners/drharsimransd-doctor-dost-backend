import { Model, Types } from 'mongoose';

export type TDoctorEarningStatus =
  | 'held'
  | 'released'
  | 'forfeited'
  | 'withdrawn'
  | 'reversed';

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
  // Set when a refund reversed this earning (status 'reversed').
  reversedAt: Date | null;
  // Amount the doctor already received and must give back (netPaise, only when the earning
  // had been paid out). recoveredPaise is taken back from later withdrawals; writtenOffPaise is
  // forgiven by an admin. Outstanding = recoveryPaise - recoveredPaise - writtenOffPaise.
  recoveryPaise: number;
  recoveredPaise: number;
  writtenOffPaise: number;
  createdAt?: Date;
  updatedAt?: Date;
}
export type DoctorEarningModel = Model<TDoctorEarning>;
