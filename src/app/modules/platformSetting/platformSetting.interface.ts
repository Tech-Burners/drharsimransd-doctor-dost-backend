import { Model } from 'mongoose';

import { TRoundingMode } from './platformSetting.constants';

export interface TPlatformSetting {
  commissionPct: number;

  dayStartTime: string;

  nightStartTime: string;

  minWalletPaise: number;

  urgentCallDayRatePaise: number;
  urgentCallNightRatePaise: number;

  roundingMode: TRoundingMode;
  prescriptionWindowMinutes: number;
  reminderMinutes: number;
  recordingRetentionYears: number;

  minWithdrawalPaise: number;

  minTopupPaise: number;
  maxTopupPaise: number;
  // provisional default 180; null disables write-offs
  recoveryPeriodDays: number | null;

  createdAt?: Date;
  updatedAt?: Date;
}

export type PlatformSettingModel = Model<TPlatformSetting>;