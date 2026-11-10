import { Model, Types } from 'mongoose';

export type TDevicePlatform = 'android' | 'ios';

export interface TDeviceToken {
  userId: Types.ObjectId;
  token: string;
  platform: TDevicePlatform;
  notificationsPermitted: boolean;
  batteryOptimised: boolean;
  lastSeenAt: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export type DeviceTokenModel = Model<TDeviceToken>;
