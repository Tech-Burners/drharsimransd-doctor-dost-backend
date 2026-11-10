import { Model, Types } from 'mongoose';

export type TSettingChangeEntityType = 'platform_setting' | 'doctor';

export interface TSettingChangeLog {
  entityType: TSettingChangeEntityType;
  entityId: Types.ObjectId | null;
  field: string;
  oldValue?: unknown;
  newValue?: unknown;
  changedBy: Types.ObjectId;
  changedAt: Date;
}

export type SettingChangeLogModel = Model<TSettingChangeLog>;
