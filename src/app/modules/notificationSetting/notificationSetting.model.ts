import { model, Schema, SchemaDefinition } from 'mongoose';
import { NOTIFICATION_TYPE } from '../notification/notification.constants';
import {
  NotificationSettingModel,
  TNotificationSetting,
} from './notificationSetting.interface';

// One Boolean (default true) for every Notification type enum value.
const typeToggles = Object.values(NOTIFICATION_TYPE).reduce(
  (fields, type) => ({ ...fields, [type]: { type: Boolean, default: true } }),
  {} as SchemaDefinition,
);

const notificationSettingSchema = new Schema<
  TNotificationSetting,
  NotificationSettingModel
>(
  {
    // One settings document per user (one-to-one).
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      unique: true,
    },
    ...typeToggles,
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

export const NotificationSetting = model<
  TNotificationSetting,
  NotificationSettingModel
>('NotificationSetting', notificationSettingSchema);
