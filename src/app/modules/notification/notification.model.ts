
import { model, Schema } from 'mongoose';
import {
  TNotification,
  NotificationModel,
} from './notification.interface';

const notificationSchema = new Schema<
  TNotification,
  NotificationModel
>(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    type: {
      type: String,
      enum: [
        'new_doctor_joined',
        'new_patient_joined',
        'call',
        'payment',
        'withdrawal',
        'prescription',
        'verification',
        'system',
      ],
      required: true,
    },
    title: {
      type: String,
      required: true,
      trim: true,
    },
    body: {
      type: String,
      required: true,
      trim: true,
    },
    data: {
      type: Schema.Types.Mixed,
      default: {},
    },
    readAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

// Get a user's notifications, newest first.
notificationSchema.index({ userId: 1, createdAt: -1 });

// Get unread notifications for a user.
notificationSchema.index({ userId: 1, readAt: 1, createdAt: -1 });

export const Notification = model<
  TNotification,
  NotificationModel
>('Notification', notificationSchema);
