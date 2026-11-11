// UNIT tests (no database): the one billing function, against the table in CLAUDE.md.
import { billedMinutes, resolveBilling } from './resolveBilling';

const RATE = 1500; // paise per minute
const bill = (durationSeconds: number, isFree = false, commissionPercent = 20, ratePaisePerMin = RATE) =>
  resolveBilling({ durationSeconds, isFree, ratePaisePerMin, commissionPercent });

describe('billedMinutes (pure round-up, no policy)', () => {
  it.each([
    [0, 0], [1, 0], [59, 0],
    [60, 1], // EXACTLY 60 seconds is chargeable
    [61, 2], [119, 2], [120, 2], [121, 3],
    [250, 5], // 4 minutes 10 seconds bills 5 minutes (client decision 6)
    [3600, 60], [3601, 61],
  ])('%i s -> %i minutes', (seconds, minutes) => {
    expect(billedMinutes(seconds)).toBe(minutes);
  });

  it('rejects a negative, fractional or non-finite duration', () => {
    for (const bad of [-1, 59.5, NaN, Infinity]) expect(() => billedMinutes(bad)).toThrow(RangeError);
  });
});

describe('resolveBilling: the table in CLAUDE.md', () => {
  it('59 s with the allowance available: free, 0 minutes, the allowance is consumed by the caller', () => {
    expect(bill(59, true)).toEqual({ billedMinutes: 0, grossPaise: 0, commissionPaise: 0, netPaise: 0 });
  });

  it('59 s with NO allowance left: billed 1 minute', () => {
    expect(bill(59, false)).toMatchObject({ billedMinutes: 1, grossPaise: RATE });
  });

  it('0 s with no allowance: still 1 minute (a short call is a short call)', () => {
    expect(bill(0, false)).toMatchObject({ billedMinutes: 1, grossPaise: RATE });
  });

  it('exactly 60 s: 1 minute, allowance untouched (isFree is false)', () => {
    expect(bill(60, false)).toMatchObject({ billedMinutes: 1, grossPaise: RATE });
  });

  it('61 s: 2 minutes', () => {
    expect(bill(61)).toMatchObject({ billedMinutes: 2, grossPaise: 2 * RATE });
  });

  it('4 min 10 s: 5 minutes', () => {
    expect(bill(250)).toMatchObject({ billedMinutes: 5, grossPaise: 5 * RATE });
  });

  it('the free flag is only valid under 60 s: 60 s or more can never be free', () => {
    expect(() => bill(60, true)).toThrow(/under 60 seconds/);
    expect(() => bill(600, true)).toThrow(/under 60 seconds/);
  });
});

describe('resolveBilling: commission and net, all integer paise', () => {
  it('20% of 1500 = 300, net 1200', () => {
    expect(bill(60)).toEqual({ billedMinutes: 1, grossPaise: 1500, commissionPaise: 300, netPaise: 1200 });
  });

  it('0% and 100% commission', () => {
    expect(bill(60, false, 0)).toMatchObject({ commissionPaise: 0, netPaise: 1500 });
    expect(bill(60, false, 100)).toMatchObject({ commissionPaise: 1500, netPaise: 0 });
  });

  it('a fractional percentage rounds to the nearest paise and commission + net is always the gross', () => {
    const r = bill(60, false, 12.5, 999); // 12.5% of 999 = 124.875 -> 125
    expect(r.commissionPaise).toBe(125);
    expect(r.netPaise).toBe(874);
    expect(r.commissionPaise + r.netPaise).toBe(r.grossPaise);
  });

  it('property: for many durations, rates and percentages everything is an integer, non-negative, and sums exactly', () => {
    for (const rate of [1, 7, 100, 999, 1500, 33333]) {
      for (const pct of [0, 1, 12.5, 20, 33.33, 99.99, 100]) {
        for (const seconds of [0, 1, 59, 60, 61, 119, 120, 121, 599, 600, 3601]) {
          for (const isFree of seconds < 60 ? [true, false] : [false]) {
            const r = resolveBilling({ durationSeconds: seconds, isFree, ratePaisePerMin: rate, commissionPercent: pct });
            for (const v of [r.billedMinutes, r.grossPaise, r.commissionPaise, r.netPaise]) {
              expect(Number.isSafeInteger(v)).toBe(true);
              expect(v).toBeGreaterThanOrEqual(0);
            }
            expect(r.commissionPaise + r.netPaise).toBe(r.grossPaise);
            expect(r.grossPaise).toBe(r.billedMinutes * rate);
          }
        }
      }
    }
  });

  it('refuses a bad rate or percentage', () => {
    expect(() => bill(60, false, 20, -1)).toThrow(RangeError);
    expect(() => bill(60, false, 20, 1.5)).toThrow(RangeError);
    expect(() => bill(60, false, -1)).toThrow(RangeError);
    expect(() => bill(60, false, 101)).toThrow(RangeError);
    expect(() => bill(60, false, NaN)).toThrow(RangeError);
  });
});
