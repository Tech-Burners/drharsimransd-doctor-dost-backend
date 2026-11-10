
import { model, Schema } from 'mongoose';
import {
  TPlatformSetting,
  PlatformSettingModel,
} from './platformSetting.interface';
import { ROUNDING_MODE } from './platformSetting.constants';

const platformSettingSchema = new Schema<TPlatformSetting>(
  {
    commissionPct: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 20,
    },

    dayStartTime: {
      type: String,
      required: true,
      default: '06:00',
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },


    nightStartTime: {
      type: String,
      required: true,
      default: '20:00',
      match: /^([01]\d|2[0-3]):[0-5]\d$/,
    },

    minWalletPaise: {
      type: Number,
      required: true,
      min: 0,
      default: 10000,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Minimum wallet balance must be a safe integer',
      },
    },

    urgentCallDayRatePaise: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Urgent day rate must be a safe integer',
      },
    },

    urgentCallNightRatePaise: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Urgent night rate must be a safe integer',
      },
    },

    roundingMode: {
      type: String,
      enum: Object.values(ROUNDING_MODE),
      default: ROUNDING_MODE.UP,
      required: true,
    },

    prescriptionWindowMinutes: {
      type: Number,
      required: true,
      min: 1,
      default: 120,
    },

    reminderMinutes: {
      type: Number,
      required: true,
      min: 1,
      default: 60,
    },

    recordingRetentionYears: {
      type: Number,
      required: true,
      min: 1,
      default: 3,
    },

    minWithdrawalPaise: {
      type: Number,
      required: true,
      min: 0,
      default: 10000,
      validate: {
        validator: Number.isSafeInteger,
        message: 'Minimum withdrawal amount must be a safe integer',
      },
    },
  },
  {
    timestamps: true,
    toJSON: {
      virtuals: true,
    },
  },
);

// The day and night windows must start at different times.
platformSettingSchema.pre('validate', function (next) {
  if (this.dayStartTime === this.nightStartTime) {
    this.invalidate(
      'nightStartTime',
      'nightStartTime must be different from dayStartTime',
    );
  }
  next();
});

// Only one platform settings document may exist.
platformSettingSchema.pre('save', async function (next) {
  const another = await (this.constructor as typeof PlatformSetting).exists({
    _id: { $ne: this._id },
  });

  if (another) {
    return next(new Error('PlatformSetting already exists'));
  }
  next();
});

export const PlatformSetting = model<
  TPlatformSetting,
  PlatformSettingModel
>('PlatformSetting', platformSettingSchema);
