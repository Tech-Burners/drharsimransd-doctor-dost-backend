// Call rate resolution helpers used by callService.start() (Phase 6A).
//
// URGENT CALLS: the price comes from PlatformSetting and nowhere else
// (`urgentCallDayRatePaise` / `urgentCallNightRatePaise`). There is NO fallback value: a
// missing, zero, negative, fractional or otherwise invalid rate rejects the call, because a
// zero rate would make the affordable duration infinite (an unlimited free call).
//
// SNAPSHOT: the resolved rate is copied onto the Call document at start (`ratePaisePerMin`)
// and billing reads it from there. Nothing here is read again for a call in progress, so
// changing PlatformSetting later never affects an ongoing call.
//
// Money is integer paise throughout.
import httpStatus from 'http-status';
import { ClientSession } from 'mongoose';
import AppError from '../../error/AppError';
import { logger } from '../../../shared/logger';
import { isWithinWindow } from '../../../shared/time';
import { PlatformSetting } from '../platformSetting/platformSetting.model';
import { CALL_TIME_SLOT } from './call.constants';

export type TCallTimeSlot = (typeof CALL_TIME_SLOT)[keyof typeof CALL_TIME_SLOT];

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A usable rate: a positive whole number of paise per minute. */
export const isValidRatePaise = (rate: unknown): rate is number =>
  typeof rate === 'number' && Number.isSafeInteger(rate) && rate > 0;

/** Client-facing error. The detail (which setting is wrong) goes to the server log only. */
const urgentUnavailable = () =>
  new AppError(httpStatus.UNPROCESSABLE_ENTITY, 'Urgent calls are not available right now');

export interface ResolvedRate {
  timeSlot: TCallTimeSlot;
  ratePaisePerMin: number;
}

interface UrgentSettingFields {
  dayStartTime?: unknown;
  nightStartTime?: unknown;
  urgentCallDayRatePaise?: unknown;
  urgentCallNightRatePaise?: unknown;
}

/**
 * Pure. The call-start instant decides the slot, once: at or after `nightStartTime` it is
 * night, until `dayStartTime`; otherwise day. Evaluated in IST through the shared helper.
 */
export const resolveTimeSlot = (now: Date, dayStartTime: string, nightStartTime: string): TCallTimeSlot =>
  isWithinWindow(now, dayStartTime, nightStartTime) ? CALL_TIME_SLOT.DAY : CALL_TIME_SLOT.NIGHT;

/**
 * Pure. The urgent rate for `now` from a PlatformSetting-shaped object, or a business error.
 * Never substitutes a default.
 */
export const urgentRateFromSetting = (setting: UrgentSettingFields | null | undefined, now: Date): ResolvedRate => {
  if (!setting) {
    logger.error('urgent call rejected: no PlatformSetting document exists');
    throw urgentUnavailable();
  }
  const { dayStartTime, nightStartTime } = setting;
  if (typeof dayStartTime !== 'string' || typeof nightStartTime !== 'string' || !HHMM.test(dayStartTime) || !HHMM.test(nightStartTime) || dayStartTime === nightStartTime) {
    logger.error('urgent call rejected: PlatformSetting day/night window is missing or invalid');
    throw urgentUnavailable();
  }

  const timeSlot = resolveTimeSlot(now, dayStartTime, nightStartTime);
  const field = timeSlot === CALL_TIME_SLOT.DAY ? 'urgentCallDayRatePaise' : 'urgentCallNightRatePaise';
  const ratePaisePerMin = setting[field];

  if (!isValidRatePaise(ratePaisePerMin)) {
    logger.error({ field, timeSlot, value: String(ratePaisePerMin) }, 'urgent call rejected: PlatformSetting rate is missing, zero or invalid');
    throw urgentUnavailable();
  }
  return { timeSlot, ratePaisePerMin };
};

/**
 * Reads PlatformSetting (pass the session when called inside the call-start transaction) and
 * returns the urgent rate to snapshot on the call. lean(): no schema defaults are applied, so
 * a field that was never written is rejected rather than silently read as 0 or anything else.
 */
export const resolveUrgentCallRate = async (now: Date = new Date(), session?: ClientSession): Promise<ResolvedRate> => {
  const setting = await PlatformSetting.findOne()
    .select('dayStartTime nightStartTime urgentCallDayRatePaise urgentCallNightRatePaise')
    .session(session ?? null)
    .lean();
  return urgentRateFromSetting(setting, now);
};

/**
 * Longest call the balance can pay for, as if the call WILL be charged:
 * floor(balance / rate) whole minutes, in seconds, so the cut-off lands on a minute boundary.
 * Refuses a rate that is not a positive whole number of paise: dividing by zero would be an
 * unlimited free call. Used for every call type.
 */
export const computeMaxAffordableSeconds = (balancePaise: number, ratePaisePerMin: number): number => {
  if (!isValidRatePaise(ratePaisePerMin)) {
    throw new AppError(httpStatus.UNPROCESSABLE_ENTITY, 'This call cannot be priced');
  }
  if (!Number.isSafeInteger(balancePaise) || balancePaise < 0) {
    throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Invalid wallet balance');
  }
  return Math.floor(balancePaise / ratePaisePerMin) * 60;
};
