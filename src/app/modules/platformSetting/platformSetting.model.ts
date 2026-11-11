
import { model, Schema } from 'mongoose';
import {
  TPlatformSetting,
  PlatformSettingModel,
} from './platformSetting.interface';
import {
  PAISE_PER_RUPEE,
  ROUNDING_MODE,
  TOPUP_DEFAULT_MAX_PAISE,
  RECOVERY_PERIOD_DEFAULT_DAYS,
  TOPUP_DEFAULT_MIN_PAISE,
} from './platformSetting.constants';

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

    // Wallet top-up limits, per transaction, in paise. Whole rupees only: both must be a
    // multiple of 100. Enforced by the server on every order, whatever the app validates.
    minTopupPaise: {
      type: Number,
      required: true,
      default: TOPUP_DEFAULT_MIN_PAISE,
      min: PAISE_PER_RUPEE,
      validate: {
        validator: (v: number) => Number.isSafeInteger(v) && v % PAISE_PER_RUPEE === 0,
        message: 'Minimum top-up must be a whole number of rupees, in paise',
      },
    },
    maxTopupPaise: {
      type: Number,
      required: true,
      default: TOPUP_DEFAULT_MAX_PAISE,
      min: PAISE_PER_RUPEE,
      validate: {
        validator: (v: number) => Number.isSafeInteger(v) && v % PAISE_PER_RUPEE === 0,
        message: 'Maximum top-up must be a whole number of rupees, in paise',
      },
    },

    // Days after a reversal before an admin may write off what is still outstanding.
    // PROVISIONAL 180, pending business approval (RECOVERY_PERIOD_DEFAULT_DAYS). Set to null to
    // refuse write-offs.
    recoveryPeriodDays: {
      type: Number,
      default: RECOVERY_PERIOD_DEFAULT_DAYS,
      min: 1,
      validate: {
        validator: (v: number | null) => v === null || Number.isInteger(v),
        message: 'Recovery period must be a whole number of days',
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

// The smallest top-up cannot exceed the largest.
platformSettingSchema.pre('validate', function (next) {
  if (this.minTopupPaise > this.maxTopupPaise) {
    this.invalidate('minTopupPaise', 'minTopupPaise must not exceed maxTopupPaise');
  }
  next();
});

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
