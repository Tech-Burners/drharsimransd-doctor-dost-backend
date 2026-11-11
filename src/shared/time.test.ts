import { isWithinWindow, istMinuteOfDay, nowInIst, toIst } from './time';

// Instants are written with an explicit +05:30 offset so the tests do not depend on the
// machine timezone.
const ist = (hhmm: string, date = '2026-06-15') => new Date(`${date}T${hhmm}:00+05:30`);

describe('isWithinWindow', () => {
  describe('night window that wraps midnight (20:00 -> 06:00)', () => {
    const night = (d: Date) => isWithinWindow(d, '20:00', '06:00');

    it('19:59 is not night, 20:00 and 20:01 are', () => {
      expect(night(ist('19:59'))).toBe(false);
      expect(night(ist('20:00'))).toBe(true);
      expect(night(ist('20:01'))).toBe(true);
    });

    it('covers both sides of midnight', () => {
      expect(night(ist('23:59'))).toBe(true);
      expect(night(ist('00:00'))).toBe(true);
      expect(night(ist('03:30'))).toBe(true);
    });

    it('ends at 06:00 exclusive', () => {
      expect(night(ist('05:59'))).toBe(true);
      expect(night(ist('06:00'))).toBe(false);
      expect(night(ist('12:00'))).toBe(false);
    });
  });

  describe('day window that does not wrap (06:00 -> 20:00)', () => {
    const day = (d: Date) => isWithinWindow(d, '06:00', '20:00');

    it('is the exact complement of the night window', () => {
      expect(day(ist('05:59'))).toBe(false);
      expect(day(ist('06:00'))).toBe(true);
      expect(day(ist('19:59'))).toBe(true);
      expect(day(ist('20:00'))).toBe(false);
    });
  });

  it('evaluates in IST, not UTC', () => {
    // 14:29 UTC is 19:59 IST; 14:31 UTC is 20:01 IST.
    expect(isWithinWindow(new Date('2026-06-15T14:29:00Z'), '20:00', '06:00')).toBe(false);
    expect(isWithinWindow(new Date('2026-06-15T14:31:00Z'), '20:00', '06:00')).toBe(true);
  });

  it('IST has no DST: the same wall-clock result in January and July', () => {
    for (const date of ['2026-01-15', '2026-07-15', '2026-03-29', '2026-10-25']) {
      expect(isWithinWindow(ist('19:59', date), '20:00', '06:00')).toBe(false);
      expect(isWithinWindow(ist('20:01', date), '20:00', '06:00')).toBe(true);
    }
  });

  it('rejects malformed times and an empty/ambiguous window', () => {
    expect(() => isWithinWindow(new Date(), '8:00', '06:00')).toThrow(RangeError);
    expect(() => isWithinWindow(new Date(), '24:00', '06:00')).toThrow(RangeError);
    expect(() => isWithinWindow(new Date(), '20:00', '20:00')).toThrow(RangeError);
  });
});

describe('toIst / nowInIst / istMinuteOfDay', () => {
  it('istMinuteOfDay reads the IST wall clock', () => {
    expect(istMinuteOfDay(ist('00:00'))).toBe(0);
    expect(istMinuteOfDay(ist('19:59'))).toBe(19 * 60 + 59);
    expect(istMinuteOfDay(new Date('2026-06-15T18:30:00Z'))).toBe(0); // 00:00 IST next day
  });

  it('toIst exposes IST wall-clock fields', () => {
    const zoned = toIst(new Date('2026-06-15T14:31:00Z'));
    expect(zoned.getHours()).toBe(20);
    expect(zoned.getMinutes()).toBe(1);
  });

  it('nowInIst returns a valid Date', () => {
    expect(Number.isNaN(nowInIst().getTime())).toBe(false);
  });
});
