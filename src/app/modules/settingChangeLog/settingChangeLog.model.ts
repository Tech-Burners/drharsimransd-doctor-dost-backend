// Append-only audit trail of commercial-term changes (commission, rate windows,
// minimum withdrawal, per-doctor terms). No soft delete, no update path, no delete path.
import { model, Schema } from 'mongoose';
import {
  TSettingChangeLog,
  SettingChangeLogModel,
} from './settingChangeLog.interface';
import { SETTING_CHANGE_ENTITY_TYPE } from './settingChangeLog.constants';

const settingChangeLogSchema = new Schema<
  TSettingChangeLog,
  SettingChangeLogModel
>(
  {
    entityType: {
      type: String,
      enum: Object.values(SETTING_CHANGE_ENTITY_TYPE),
      required: true,
    },
    entityId: { type: Schema.Types.ObjectId, default: null },
    field: { type: String, required: true },
    oldValue: { type: Schema.Types.Mixed },
    newValue: { type: Schema.Types.Mixed },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    changedAt: { type: Date, default: Date.now },
  },
  { strict: true },
);

settingChangeLogSchema.index({ entityType: 1, entityId: 1, changedAt: -1 });

// Append-only: reject every update and delete path at the schema level.
const blockOp = (op: string) =>
  function (next: (err?: Error) => void) {
    next(new Error('SettingChangeLog is append-only: ' + op + ' is not allowed'));
  };

settingChangeLogSchema.pre(
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne'],
  blockOp('update'),
);
settingChangeLogSchema.pre(
  ['deleteOne', 'deleteMany', 'findOneAndDelete'],
  blockOp('delete'),
);
settingChangeLogSchema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('SettingChangeLog is append-only'));
  next();
});

export const SettingChangeLog = model<
  TSettingChangeLog,
  SettingChangeLogModel
>('SettingChangeLog', settingChangeLogSchema);
