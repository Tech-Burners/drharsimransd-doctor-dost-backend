import { model, Schema } from 'mongoose';
import { TDeviceToken, DeviceTokenModel } from './deviceToken.interface';
import { DEVICE_PLATFORM } from './deviceToken.constants';

const deviceTokenSchema = new Schema<TDeviceToken>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    token: {
      type: String,
      required: true,
      unique: true,
    },
    platform: {
      type: String,
      enum: Object.values(DEVICE_PLATFORM),
      required: true,
    },
    notificationsPermitted: {
      type: Boolean,
      default: true,
    },
    batteryOptimised: {
      type: Boolean,
      default: false,
    },
    lastSeenAt: {
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

deviceTokenSchema.index({ userId: 1 });

export const DeviceToken = model<TDeviceToken, DeviceTokenModel>(
  'DeviceToken',
  deviceTokenSchema,
);
