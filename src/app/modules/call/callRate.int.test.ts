// Urgent-call pricing: the rate comes from PlatformSetting, is validated, has NO fallback, and
// is snapshotted on the call. Reads the real database (replica set) because the rate is read
// from the PlatformSetting collection.
import mongoose from 'mongoose';
import { useTestDb } from '../../../test/helpers/db';
import { PlatformSetting } from '../platformSetting/platformSetting.model';
import { Call } from './call.model';
import {
  computeMaxAffordableSeconds,
  isValidRatePaise,
  resolveTimeSlot,
  resolveUrgentCallRate,
  urgentRateFromSetting,
} from './callRate';

// IST = UTC + 5:30
const IST = {
  noon: new Date('2026-03-10T06:30:00Z'), // 12:00 IST  -> day
  justBeforeNight: new Date('2026-03-10T14:29:00Z'), // 19:59 IST -> day
  nightStarts: new Date('2026-03-10T14:30:00Z'), // 20:00 IST -> night (inclusive)
  lateNight: new Date('2026-03-10T20:30:00Z'), // 02:00 IST -> night
  beforeDay: new Date('2026-03-10T00:29:00Z'), // 05:59 IST -> night
  dayStarts: new Date('2026-03-10T00:30:00Z'), // 06:00 IST -> day
};

const baseSetting = {
  commissionPct: 20, dayStartTime: '06:00', nightStartTime: '20:00', minWalletPaise: 10000,
  urgentCallDayRatePaise: 0, urgentCallNightRatePaise: 0, roundingMode: 'up',
  prescriptionWindowMinutes: 120, reminderMinutes: 60, recordingRetentionYears: 3, minWithdrawalPaise: 10000,
};
/** Inserted raw so invalid values reach the resolver (the schema would stop most of them). */
const rawSetting = (overrides: Record<string, unknown>) => PlatformSetting.collection.insertOne({ ...baseSetting, ...overrides });

const rejects = async (p: Promise<unknown> | (() => unknown)) => {
  const run = typeof p === 'function' ? Promise.resolve().then(p) : p;
  await expect(run).rejects.toMatchObject({ statusCode: 422, message: 'Urgent calls are not available right now' });
};

describe('urgent call rate from PlatformSetting', () => {
  useTestDb();

  describe('valid rates', () => {
    it('uses the configured DAY rate in the day and the NIGHT rate at night (integer paise)', async () => {
      await rawSetting({ urgentCallDayRatePaise: 1500, urgentCallNightRatePaise: 2500 });
      expect(await resolveUrgentCallRate(IST.noon)).toEqual({ timeSlot: 'day', ratePaisePerMin: 1500 });
      expect(await resolveUrgentCallRate(IST.lateNight)).toEqual({ timeSlot: 'night', ratePaisePerMin: 2500 });
    });

    it('the day/night boundary: 19:59 is day, 20:00 is night, 05:59 is night, 06:00 is day', async () => {
      await rawSetting({ urgentCallDayRatePaise: 1500, urgentCallNightRatePaise: 2500 });
      expect((await resolveUrgentCallRate(IST.justBeforeNight)).ratePaisePerMin).toBe(1500);
      expect((await resolveUrgentCallRate(IST.nightStarts)).ratePaisePerMin).toBe(2500);
      expect((await resolveUrgentCallRate(IST.beforeDay)).ratePaisePerMin).toBe(2500);
      expect((await resolveUrgentCallRate(IST.dayStarts)).ratePaisePerMin).toBe(1500);
    });

    it('follows the configured window, not a hardcoded one', async () => {
      await rawSetting({ dayStartTime: '08:00', nightStartTime: '21:00', urgentCallDayRatePaise: 1500, urgentCallNightRatePaise: 2500 });
      // 06:30 IST is night when the day starts at 08:00 (the open "night window end" question)
      expect(resolveTimeSlot(new Date('2026-03-10T01:00:00Z'), '08:00', '21:00')).toBe('night');
      expect((await resolveUrgentCallRate(new Date('2026-03-10T01:00:00Z'))).ratePaisePerMin).toBe(2500);
      expect((await resolveUrgentCallRate(new Date('2026-03-10T04:00:00Z'))).ratePaisePerMin).toBe(1500); // 09:30 IST
    });

    it('works through a normal schema-validated document and picks up a later change', async () => {
      const s = await PlatformSetting.create({ urgentCallDayRatePaise: 1200 });
      expect((await resolveUrgentCallRate(IST.noon)).ratePaisePerMin).toBe(1200);
      await PlatformSetting.updateOne({ _id: s._id }, { urgentCallDayRatePaise: 1800 });
      expect((await resolveUrgentCallRate(IST.noon)).ratePaisePerMin).toBe(1800);
    });
  });

  describe('missing rates are rejected, never defaulted', () => {
    it('no PlatformSetting document at all', async () => {
      await rejects(resolveUrgentCallRate(IST.noon));
    });

    it('the rate field was never written (an old document)', async () => {
      const { urgentCallDayRatePaise: _d, urgentCallNightRatePaise: _n, ...withoutRates } = baseSetting;
      void _d; void _n;
      await PlatformSetting.collection.insertOne(withoutRates);
      await rejects(resolveUrgentCallRate(IST.noon));
      await rejects(resolveUrgentCallRate(IST.lateNight));
    });

    it('the rate is null', async () => {
      await rawSetting({ urgentCallDayRatePaise: null, urgentCallNightRatePaise: null });
      await rejects(resolveUrgentCallRate(IST.noon));
    });

    it('the day/night window is missing: it does not fall back to 06:00 / 20:00', async () => {
      const { dayStartTime: _a, nightStartTime: _b, ...noWindow } = baseSetting;
      void _a; void _b;
      await PlatformSetting.collection.insertOne({ ...noWindow, urgentCallDayRatePaise: 1500, urgentCallNightRatePaise: 2500 });
      await rejects(resolveUrgentCallRate(IST.noon));
    });
  });

  describe('zero rates are rejected (the default state)', () => {
    it('the schema defaults (0 / 0) reject urgent calls: they are not free calls', async () => {
      await PlatformSetting.create({});
      await rejects(resolveUrgentCallRate(IST.noon));
      await rejects(resolveUrgentCallRate(IST.lateNight));
    });

    it('rates are checked per slot: a zero DAY rate rejects only in the day', async () => {
      await rawSetting({ urgentCallDayRatePaise: 0, urgentCallNightRatePaise: 2500 });
      await rejects(resolveUrgentCallRate(IST.noon));
      expect((await resolveUrgentCallRate(IST.lateNight)).ratePaisePerMin).toBe(2500);
    });

    it('a zero NIGHT rate rejects only at night', async () => {
      await rawSetting({ urgentCallDayRatePaise: 1500, urgentCallNightRatePaise: 0 });
      expect((await resolveUrgentCallRate(IST.noon)).ratePaisePerMin).toBe(1500);
      await rejects(resolveUrgentCallRate(IST.lateNight));
    });
  });

  describe('invalid rates are rejected', () => {
    const invalid: Array<[string, unknown]> = [
      ['negative', -500],
      ['fractional paise', 1500.5],
      ['a numeric string', '1500'],
      ['NaN', Number.NaN],
      ['Infinity', Number.POSITIVE_INFINITY],
      ['above the safe integer range', Number.MAX_SAFE_INTEGER + 2],
      ['a boolean', true],
      ['an object', { paise: 1500 }],
      ['an array', [1500]],
    ];
    it.each(invalid)('%s', async (_label, value) => {
      await rawSetting({ urgentCallDayRatePaise: value, urgentCallNightRatePaise: value });
      await rejects(resolveUrgentCallRate(IST.noon));
      await rejects(resolveUrgentCallRate(IST.lateNight));
    });

    it('an ambiguous window (day start equals night start) is rejected, not guessed', async () => {
      await rawSetting({ dayStartTime: '06:00', nightStartTime: '06:00', urgentCallDayRatePaise: 1500, urgentCallNightRatePaise: 2500 });
      await rejects(resolveUrgentCallRate(IST.noon));
    });

    it('a malformed time string is rejected', async () => {
      await rawSetting({ dayStartTime: '6am', urgentCallDayRatePaise: 1500, urgentCallNightRatePaise: 2500 });
      await rejects(resolveUrgentCallRate(IST.noon));
    });

    it('the client-facing message never says which setting is wrong', async () => {
      await rawSetting({});
      const err = await resolveUrgentCallRate(IST.noon).catch((e) => e);
      expect(err.message).toBe('Urgent calls are not available right now');
    });
  });

  describe('the pure helpers', () => {
    it('isValidRatePaise accepts only positive whole paise', () => {
      for (const ok of [1, 100, 1500, Number.MAX_SAFE_INTEGER]) expect(isValidRatePaise(ok)).toBe(true);
      for (const bad of [0, -1, 0.5, 1.5, NaN, Infinity, '100', null, undefined, {}, true, Number.MAX_SAFE_INTEGER + 2]) {
        expect(isValidRatePaise(bad)).toBe(false);
      }
    });

    it('urgentRateFromSetting needs no database and never invents a rate', () => {
      expect(urgentRateFromSetting({ ...baseSetting, urgentCallDayRatePaise: 900 }, IST.noon)).toEqual({ timeSlot: 'day', ratePaisePerMin: 900 });
      expect(() => urgentRateFromSetting(baseSetting, IST.noon)).toThrow(/not available/);
      expect(() => urgentRateFromSetting(null, IST.noon)).toThrow(/not available/);
      expect(() => urgentRateFromSetting(undefined, IST.noon)).toThrow(/not available/);
    });
  });

  describe('affordable duration can never be infinite', () => {
    it('floor(balance / rate) whole minutes, in seconds, on a minute boundary', () => {
      expect(computeMaxAffordableSeconds(10000, 1500)).toBe(6 * 60); // 6.67 min -> 6 whole minutes
      expect(computeMaxAffordableSeconds(3000, 1500)).toBe(2 * 60);
      expect(computeMaxAffordableSeconds(2999, 1500)).toBe(60);
      expect(computeMaxAffordableSeconds(1499, 1500)).toBe(0); // cannot afford one minute
      expect(computeMaxAffordableSeconds(0, 1500)).toBe(0);
      for (const balance of [1, 99, 1500, 12345, 99999]) {
        expect(computeMaxAffordableSeconds(balance, 1500) % 60).toBe(0);
        // never more minutes than the balance pays for
        expect((computeMaxAffordableSeconds(balance, 1500) / 60) * 1500).toBeLessThanOrEqual(balance);
      }
    });

    it.each([0, -1, 1.5, NaN, Infinity, null, undefined, '1500'])('refuses rate %p instead of returning Infinity or NaN', (rate) => {
      expect(() => computeMaxAffordableSeconds(10000, rate as number)).toThrow(/cannot be priced/);
    });

    it('refuses a negative, fractional or non-numeric balance', () => {
      for (const balance of [-1, 10.5, NaN, Infinity]) {
        expect(() => computeMaxAffordableSeconds(balance, 1500)).toThrow(/Invalid wallet balance/);
      }
    });
  });

  describe('the rate is captured at call start and later changes do not touch the call', () => {
    it('a Call keeps its snapshot when PlatformSetting changes', async () => {
      const s = await PlatformSetting.create({ urgentCallDayRatePaise: 1500, urgentCallNightRatePaise: 2500 });
      const resolved = await resolveUrgentCallRate(IST.noon);
      const balance = 10000;
      const callId = new mongoose.Types.ObjectId();
      // what callService.start() will store: the resolved values, copied by value onto the call
      await Call.collection.insertOne({
        _id: callId, patientId: new mongoose.Types.ObjectId(), doctorId: new mongoose.Types.ObjectId(),
        status: 'ringing', isUrgent: true, timeSlot: resolved.timeSlot, ratePaisePerMin: resolved.ratePaisePerMin,
        maxAffordableSeconds: computeMaxAffordableSeconds(balance, resolved.ratePaisePerMin), agoraChannelName: `ch-${callId}`,
      });

      await PlatformSetting.updateOne({ _id: s._id }, { urgentCallDayRatePaise: 9000, urgentCallNightRatePaise: 9500 });

      const call = (await Call.collection.findOne({ _id: callId }))!;
      expect(call.ratePaisePerMin).toBe(1500);
      expect(call.maxAffordableSeconds).toBe(360);
      expect(call.timeSlot).toBe('day');
      // a NEW call sees the new price; the running one does not
      expect((await resolveUrgentCallRate(IST.noon)).ratePaisePerMin).toBe(9000);
      expect((await Call.collection.findOne({ _id: callId }))!.ratePaisePerMin).toBe(1500);
    });

    it('resolving returns plain values, not a live reference to the setting', async () => {
      await PlatformSetting.create({ urgentCallDayRatePaise: 1500 });
      const resolved = await resolveUrgentCallRate(IST.noon);
      expect(Object.keys(resolved).sort()).toEqual(['ratePaisePerMin', 'timeSlot']);
      expect(typeof resolved.ratePaisePerMin).toBe('number');
    });

    it('can be read inside a transaction session (the call-start session)', async () => {
      await PlatformSetting.create({ urgentCallDayRatePaise: 1500 });
      const { runInTransaction } = await import('../../../shared/transaction');
      const r = await runInTransaction((session) => resolveUrgentCallRate(IST.noon, session));
      expect(r.ratePaisePerMin).toBe(1500);
    });
  });
});
