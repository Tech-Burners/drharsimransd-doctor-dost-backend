// Every rate-window comparison in the codebase goes through this module.
// No raw Date arithmetic on hours or minutes anywhere else (CLAUDE.md, Timezone).
//
// All window logic is evaluated in Asia/Kolkata on the server. Dates are stored in UTC.
import { formatInTimeZone, toZonedTime } from 'date-fns-tz';

export const IST_TIMEZONE = 'Asia/Kolkata';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** The current instant, as an IST wall-clock Date. See toIst() for the caveat. */
export const nowInIst = (): Date => toIst(new Date());

/**
 * Returns a Date whose LOCAL fields (getHours(), getMinutes() ...) read as the IST wall
 * clock for the given instant. It is for reading wall-clock fields only. Never compare it
 * with a real instant and never store it: it is not the same moment as the input.
 */
export const toIst = (date: Date): Date => toZonedTime(date, IST_TIMEZONE);

/** Minutes since IST midnight (0..1439) for the given instant. */
export const istMinuteOfDay = (date: Date): number => {
  const [hh, mm] = formatInTimeZone(date, IST_TIMEZONE, 'HH:mm').split(':');
  return Number(hh) * 60 + Number(mm);
};

const parseHHmm = (value: string): number => {
  const match = HHMM.exec(value);
  if (!match) {
    throw new RangeError(`Invalid HH:mm time: "${value}"`);
  }
  return Number(match[1]) * 60 + Number(match[2]);
};

/**
 * True when the IST wall-clock time of `date` falls inside [startHHmm, endHHmm).
 * Start is inclusive, end is exclusive. When start is later than end the window wraps
 * past midnight, e.g. 20:00 -> 06:00. A window whose start equals its end is ambiguous
 * (empty or all day) and is rejected; PlatformSetting forbids it for the same reason.
 */
export const isWithinWindow = (
  date: Date,
  startHHmm: string,
  endHHmm: string,
): boolean => {
  const start = parseHHmm(startHHmm);
  const end = parseHHmm(endHHmm);
  if (start === end) {
    throw new RangeError('Window start and end must differ');
  }
  const minute = istMinuteOfDay(date);
  return start < end
    ? minute >= start && minute < end
    : minute >= start || minute < end;
};
