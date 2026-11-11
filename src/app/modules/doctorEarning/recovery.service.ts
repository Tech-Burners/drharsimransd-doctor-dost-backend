// Doctor-side recovery: what a doctor owes back after a refund reversed money they had
// already received, how it is taken from later withdrawals, and how an admin writes off
// what can never be recovered. Every change is an append-only DoctorLedgerAdjustment; the
// totals on the DoctorEarning row are derived from, and always match, those entries.
import httpStatus from 'http-status';
import { ClientSession, Types } from 'mongoose';
import AppError from '../../error/AppError';
import { runInTransaction } from '../../../shared/transaction';
import { DoctorEarning } from './doctorEarning.model';
import { DOCTOR_EARNING_STATUS } from './doctorEarning.constants';
import { TDoctorEarning } from './doctorEarning.interface';
import {
  DOCTOR_ADJUSTMENT_TYPE,
  DoctorLedgerAdjustment,
} from '../doctorLedgerAdjustment/doctorLedgerAdjustment.model';
import { PlatformSetting } from '../platformSetting/platformSetting.model';
import { RECOVERY_PERIOD_DEFAULT_DAYS } from '../platformSetting/platformSetting.constants';

type Id = string | Types.ObjectId;

export const outstandingOf = (e: Pick<TDoctorEarning, 'recoveryPaise' | 'recoveredPaise' | 'writtenOffPaise'>) =>
  Math.max(0, e.recoveryPaise - e.recoveredPaise - e.writtenOffPaise);

const openRecoveries = (doctorId: Id, session?: ClientSession) =>
  DoctorEarning.find({ doctorId, recoveryPaise: { $gt: 0 } })
    .sort({ reversedAt: 1, _id: 1 })
    .session(session ?? null);

/** Total the doctor still owes, across every reversed earning. */
const outstandingForDoctor = async (doctorId: Id, session?: ClientSession): Promise<number> => {
  const rows = await openRecoveries(doctorId, session);
  return rows.reduce((sum, r) => sum + outstandingOf(r), 0);
};

/**
 * What the doctor can withdraw now: released, unclaimed net earnings, minus what they
 * owe. Never negative; a debt larger than their balance carries over to the next earnings.
 * Phase 7's withdrawal request uses this figure (and the minimum withdrawal applies to it).
 */
const getWithdrawable = async (doctorId: Id, session?: ClientSession) => {
  const released = await DoctorEarning.find({
    doctorId,
    status: DOCTOR_EARNING_STATUS.RELEASED,
    withdrawalRequestId: null,
  })
    .select('netPaise')
    .session(session ?? null)
    .lean();
  const releasedUnclaimedPaise = released.reduce((s, r) => s + r.netPaise, 0);
  const outstandingRecoveryPaise = await outstandingForDoctor(doctorId, session);
  return {
    releasedUnclaimedPaise,
    outstandingRecoveryPaise,
    withdrawablePaise: Math.max(0, releasedUnclaimedPaise - outstandingRecoveryPaise),
  };
};

/**
 * Take recovery out of a withdrawal, INSIDE the withdrawal request's transaction. Oldest debt
 * first, never more than `maxPaise`. Returns how much was taken: the request must claim that
 * much extra released earnings so the doctor's payout is amount, not amount minus recovery.
 */
const applyToWithdrawal = async (
  session: ClientSession,
  input: { doctorId: Id; withdrawalRequestId: Id; maxPaise: number },
): Promise<number> => {
  let remaining = input.maxPaise;
  let applied = 0;
  for (const e of await openRecoveries(input.doctorId, session)) {
    if (remaining <= 0) break;
    const take = Math.min(outstandingOf(e), remaining);
    if (take <= 0) continue;
    const res = await DoctorEarning.updateOne(
      { _id: e._id, recoveredPaise: e.recoveredPaise, writtenOffPaise: e.writtenOffPaise },
      { $inc: { recoveredPaise: take } },
      { session },
    );
    if (res.modifiedCount !== 1) throw new AppError(httpStatus.CONFLICT, 'Recovery changed while it was being applied');
    await DoctorLedgerAdjustment.create(
      [
        {
          doctorId: e.doctorId,
          earningId: e._id,
          callId: e.callId,
          type: DOCTOR_ADJUSTMENT_TYPE.RECOVERY_SETTLED,
          amountPaise: take,
          withdrawalRequestId: input.withdrawalRequestId,
          idempotencyKey: `earning:${e._id}:settle:${input.withdrawalRequestId}`,
          note: 'Recovered from a withdrawal',
        },
      ],
      { session },
    );
    remaining -= take;
    applied += take;
  }
  return applied;
};

/** Admin: list open recoveries (read only). */
const listOpen = async (page: number, limit: number) => {
  const filter = { recoveryPaise: { $gt: 0 } };
  const rows = await DoctorEarning.find(filter)
    .sort({ reversedAt: 1, _id: 1 })
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();
  const open = rows
    .map((r) => ({ ...r, outstandingPaise: outstandingOf(r) }))
    .filter((r) => r.outstandingPaise > 0);
  return { rows: open, meta: { page, limit } };
};

/**
 * Admin write-off of what is still outstanding on one reversed earning. Allowed only after
 * the recovery period (PlatformSetting.recoveryPeriodDays, counted from reversedAt; provisional default 180 days,
 * pending business approval; null disables write-offs).
 * Recorded as an append-only adjustment; the earning row and its history are untouched
 * apart from the running total.
 */
const writeOff = async (actor: { userId: string }, input: { earningId: string; note: string }) => {
  if (!Types.ObjectId.isValid(input.earningId)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid earning id');

  return runInTransaction(async (session) => {
    const setting = await PlatformSetting.findOne().session(session).lean();
    // lean() applies no schema defaults, so a missing field (an older settings document, or
    // no document at all) means the provisional default. An explicit null means disabled.
    const days = setting?.recoveryPeriodDays === undefined ? RECOVERY_PERIOD_DEFAULT_DAYS : setting.recoveryPeriodDays;
    if (days === null) {
      throw new AppError(httpStatus.CONFLICT, 'Write-offs are disabled (recoveryPeriodDays is null)');
    }

    const e = await DoctorEarning.findById(input.earningId).session(session);
    if (!e) throw new AppError(httpStatus.NOT_FOUND, 'Earning not found');
    const outstanding = outstandingOf(e);
    if (e.status !== DOCTOR_EARNING_STATUS.REVERSED || outstanding <= 0) {
      throw new AppError(httpStatus.CONFLICT, 'This earning has no outstanding recovery');
    }
    const eligibleAt = new Date((e.reversedAt as Date).getTime() + days * 24 * 3600 * 1000);
    if (Date.now() < eligibleAt.getTime()) {
      throw new AppError(httpStatus.CONFLICT, `The recovery period has not ended (write-off allowed from ${eligibleAt.toISOString()})`);
    }

    const res = await DoctorEarning.updateOne(
      { _id: e._id, recoveredPaise: e.recoveredPaise, writtenOffPaise: e.writtenOffPaise },
      { $inc: { writtenOffPaise: outstanding } },
      { session },
    );
    if (res.modifiedCount !== 1) throw new AppError(httpStatus.CONFLICT, 'Recovery changed while it was being written off');

    await DoctorLedgerAdjustment.create(
      [
        {
          doctorId: e.doctorId,
          earningId: e._id,
          callId: e.callId,
          type: DOCTOR_ADJUSTMENT_TYPE.RECOVERY_WRITE_OFF,
          amountPaise: outstanding,
          idempotencyKey: `earning:${e._id}:writeoff`,
          createdBy: actor.userId,
          note: input.note,
          metadata: { recoveryPeriodDays: days, reversedAt: e.reversedAt },
        },
      ],
      { session },
    );
    return { earningId: String(e._id), writtenOffPaise: outstanding };
  }).catch((err) => {
    if ((err as { code?: number }).code === 11000) {
      throw new AppError(httpStatus.CONFLICT, 'This recovery has already been written off');
    }
    throw err;
  });
};

export const recoveryService = { outstandingForDoctor, getWithdrawable, applyToWithdrawal, listOpen, writeOff };
