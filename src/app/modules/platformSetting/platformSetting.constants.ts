export const ROUNDING_MODE = {
  UP: 'up',
  DOWN: 'down',
  EXACT: 'exact',
} as const;

export type TRoundingMode = (typeof ROUNDING_MODE)[keyof typeof ROUNDING_MODE];

// Wallet top-up limits (client decision): minimum Rs 100, maximum Rs 50,000 per transaction,
// whole rupees only. These are the schema defaults AND the fallback when no PlatformSetting
// document exists yet; the stored values win once set.
export const PAISE_PER_RUPEE = 100;
export const TOPUP_DEFAULT_MIN_PAISE = 100 * PAISE_PER_RUPEE;
export const TOPUP_DEFAULT_MAX_PAISE = 50000 * PAISE_PER_RUPEE;

// Days after a reversal before an admin may write off an unrecoverable doctor balance.
// PROVISIONAL: recommended 180 days, pending business approval. Change it in PlatformSetting;
// set it to null to disable write-offs altogether.
export const RECOVERY_PERIOD_DEFAULT_DAYS = 180;
