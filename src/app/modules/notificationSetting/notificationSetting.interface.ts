import { Model, Types } from 'mongoose';
import { TNotificationType } from '../notification/notification.interface';

// One boolean per notification type; true => the user receives that type.
export type TNotificationSetting = {
  userId: Types.ObjectId;
  createdAt?: Date;
  updatedAt?: Date;
} & Record<TNotificationType, boolean>;

export type NotificationSettingModel = Model<TNotificationSetting>;
