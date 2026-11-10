import { model, Schema } from 'mongoose';
import {
  TRecordingAccessLog,
  RecordingAccessLogModel,
} from './recordingAccessLog.interface';
import {
  RECORDING_ACCESS_ACTION,
  RECORDING_ACCESS_REASON,
  RECORDING_ACCESS_ROLE,
} from './recordingAccessLog.constants';

const recordingAccessLogSchema = new Schema<TRecordingAccessLog>(
  {
    callId: {
      type: Schema.Types.ObjectId,
      ref: 'Call',
      required: true,
    },
    accessedBy: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    accessedAs: {
      type: String,
      enum: Object.values(RECORDING_ACCESS_ROLE),
      required: true,
    },
    action: {
      type: String,
      enum: Object.values(RECORDING_ACCESS_ACTION),
      required: true,
    },
    reason: {
      type: String,
      enum: Object.values(RECORDING_ACCESS_REASON),
      required: true,
    },
    reasonNote: {
      type: String,
      default: '',
    },
    objectKey: {
      type: String,
      required: true,
    },
    ipAddress: {
      type: String,
      default: '',
    },
    userAgent: {
      type: String,
      default: '',
    },
    accessedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

recordingAccessLogSchema.index({ callId: 1, createdAt: -1 });
recordingAccessLogSchema.index({ accessedBy: 1, createdAt: -1 });

export const RecordingAccessLog = model<
  TRecordingAccessLog,
  RecordingAccessLogModel
>('RecordingAccessLog', recordingAccessLogSchema);
