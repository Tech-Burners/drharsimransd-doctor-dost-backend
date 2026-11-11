// THE billing function. Patient charge, doctor earning, refund amount and admin views all use
// this one function (CLAUDE.md, Billing). Pure, integer paise only.
//
//   durationSeconds < 60            -> 0 billed minutes
//   otherwise                       -> Math.ceil(durationSeconds / 60)   (60 s EXACTLY is chargeable)
//
//   | Duration     | Allowance available | Billed                                   |
//   | Under 60 s   | Yes (isFree = true) | 0 minutes (the allowance is consumed)    |
//   | Under 60 s   | No                  | 1 minute                                 |
//   | Exactly 60 s | either              | 1 minute, allowance untouched            |
//   | 61 to 120 s  | either              | 2 minutes                                |
import { Types } from 'mongoose';

/** Pure round-up, no policy. */
export const billedMinutes = (durationSeconds: number): number => {
  assertDuration(durationSeconds);
  return durationSeconds < 60 ? 0 : Math.ceil(durationSeconds / 60);
};

const assertDuration = (durationSeconds: number) => {
  if (!Number.isSafeInteger(durationSeconds) || durationSeconds < 0) {
    throw new RangeError('durationSeconds must be a non-negative whole number');
  }
};

export interface BillingInput {
  durationSeconds: number;
  /** True only when the free short-call allowance was claimed for this call. */
  isFree: boolean;
  ratePaisePerMin: number;
  /** The percentage SNAPSHOT on the call, 0 to 100. Two decimals are honoured (12.34). */
  commissionPercent: number;
}

export interface BillingResult {
  billedMinutes: number;
  grossPaise: number;
  commissionPaise: number;
  netPaise: number;
}

export const resolveBilling = (input: BillingInput): BillingResult => {
  const { durationSeconds, isFree, ratePaisePerMin, commissionPercent } = input;
  assertDuration(durationSeconds);
  if (!Number.isSafeInteger(ratePaisePerMin) || ratePaisePerMin < 0) {
    throw new RangeError('ratePaisePerMin must be a non-negative whole number of paise');
  }
  if (typeof commissionPercent !== 'number' || !Number.isFinite(commissionPercent) || commissionPercent < 0 || commissionPercent > 100) {
    throw new RangeError('commissionPercent must be between 0 and 100');
  }
  if (isFree && durationSeconds >= 60) {
    throw new RangeError('Only a call under 60 seconds can use the free allowance');
  }

  let minutes: number;
  if (isFree) minutes = 0;
  else if (durationSeconds < 60) minutes = 1; // a short call with no allowance left is billed one minute
  else minutes = billedMinutes(durationSeconds);

  const grossPaise = minutes * ratePaisePerMin;
  if (!Number.isSafeInteger(grossPaise)) throw new RangeError('gross amount out of range');

  // Commission in integer paise. The percentage is held in basis points (hundredths of a
  // percent) so no float multiplication decides the result. Rounding to the nearest paise is an
  // assumption (CLAUDE.md does not specify it); net is the remainder, so commission + net always
  // equals gross exactly.
  const basisPoints = Math.round(commissionPercent * 100);
  const commissionPaise = Math.round((grossPaise * basisPoints) / 10000);
  const netPaise = grossPaise - commissionPaise;

  return { billedMinutes: minutes, grossPaise, commissionPaise, netPaise };
};

export const isDuplicateKeyError = (err: unknown): boolean => (err as { code?: number })?.code === 11000;

export const toObjectId = (id: string | Types.ObjectId) => new Types.ObjectId(String(id));
