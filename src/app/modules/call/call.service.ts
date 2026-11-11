// Call lifecycle and billing.
//
//   start    patient   one session: checks, rate snapshot, balance read INSIDE it, insert `ringing`
//   accept   doctor    ringing -> active, mints the doctor's token, arms the cut-off timers
//   reject   doctor    ringing -> rejected
//   missed   system    ringing -> missed (30 s job, with a sweep as the safety net)
//   finalize system    active -> completed / ended_low_balance. THE billing path (6B)
//   cutOff   system    affordable duration reached: set endReason, close the channel
//   closeNoEndEvent    sweep condition B: a technical necessity, NOT a billing rule
//
// Rules in force (CLAUDE.md): no client is trusted for money, duration or state; the duration
// comes from the Agora events; one billing function (resolveBilling); ledger authoritative; all
// money integer paise; sessions only for call start and call end; nothing external inside a
// session (token minting, push, sockets and queues all happen after commit).
import { randomInt } from 'crypto';
import httpStatus from 'http-status';
import { ClientSession, Types } from 'mongoose';
import config from '../../config';
import AppError from '../../error/AppError';
import { logger } from '../../../shared/logger';
import { setCallId } from '../../../shared/requestContext';
import { cooldown } from '../../../shared/rateLimit';
import { runInTransaction } from '../../../shared/transaction';
import { getAgoraClient, tryCloseChannel } from '../../../shared/agora';
import { trySendPush } from '../../../shared/fcm';
import { emitToUser } from '../../../shared/realtime';
import { Call } from './call.model';
import { CALL_END_REASON, CALL_STATUS, PRESCRIPTION_STATUS } from './call.constants';
import {
  computeMaxAffordableSeconds,
  isValidRatePaise,
  resolveTimeSlot,
  resolveUrgentCallRate,
} from './callRate';
import { analyseCallPresence, PresenceEvent } from './deriveCallDuration';
import { FINALIZE_DELAY_MS, RING_TIMEOUT_SECONDS, tryJob, WARNING_SECONDS_BEFORE_CUTOFF } from './call.jobs';
import { Doctor } from '../doctor/doctor.model';
import { DOCTOR_APPROVAL_STATUS } from '../doctor/doctor.constants';
import { DoctorEarning } from '../doctorEarning/doctorEarning.model';
import { DOCTOR_EARNING_STATUS } from '../doctorEarning/doctorEarning.constants';
import { User } from '../user/user.model';
import { DeviceToken } from '../deviceToken/deviceToken.model';
import { PlatformSetting } from '../platformSetting/platformSetting.model';
import { AgoraCallEvent } from '../agoraCallEvent/agoraCallEvent.model';
import { ShortCallAllowance } from '../shortCallAllowance/shortCallAllowance.model';
import { presenceService } from '../presence/presence.service';
import { walletService } from '../wallet/wallet.service';
import { WALLET_LEDGER_DIRECTION, WALLET_LEDGER_TYPE } from '../wallet/walletLedger.constants';
import { ReconciliationFinding } from '../reconciliationFinding/reconciliationFinding.model';
import { resolveBilling } from '../billing/resolveBilling';

export const chargeKey = (callId: string) => `call:${callId}:charge`;

type Actor = { userId: string; role?: string };

// ------------------------------------------------------------------ settings

/** Hydrated (not lean) so documented schema defaults apply to fields an older document lacks. */
const loadSettings = async (session?: ClientSession) => {
  const s = await PlatformSetting.findOne().session(session ?? null);
  if (!s) {
    logger.error('calls unavailable: no PlatformSetting document');
    throw new AppError(httpStatus.SERVICE_UNAVAILABLE, 'Calling is not configured');
  }
  return s;
};

// ----------------------------------------------------------------- timers
// The second cut-off layer: an in-process timer in the API instance that accepted the call.
// Lost on a restart; the 30 second sweep (call.sweep.ts) is the third layer.
const timers = new Map<string, NodeJS.Timeout[]>();

export const clearCallTimers = (callId: string) => {
  for (const t of timers.get(callId) ?? []) clearTimeout(t);
  timers.delete(callId);
};

const armCallTimers = (call: { _id: unknown; patientId: unknown; doctorUserId: string; maxAffordableSeconds: number; startedAt: Date }) => {
  const callId = String(call._id);
  clearCallTimers(callId);
  const cutoffAt = call.startedAt.getTime() + call.maxAffordableSeconds * 1000;
  const list: NodeJS.Timeout[] = [];
  const warnIn = cutoffAt - Date.now() - WARNING_SECONDS_BEFORE_CUTOFF * 1000;
  if (warnIn > 0) {
    list.push(
      setTimeout(() => {
        const payload = { callId, secondsRemaining: WARNING_SECONDS_BEFORE_CUTOFF };
        emitToUser(String(call.patientId), 'call:warning', payload);
        emitToUser(call.doctorUserId, 'call:warning', payload);
      }, warnIn),
    );
  }
  list.push(
    setTimeout(() => {
      void cutOff(callId).catch((err) => logger.error({ err, callId }, 'cut-off timer failed; the sweep will retry'));
    }, Math.max(0, cutoffAt - Date.now())),
  );
  for (const t of list) t.unref();
  timers.set(callId, list);
};

// ------------------------------------------------------------------- start

export interface StartInput {
  doctorId: string;
  isUrgent?: boolean;
}

const randomUid = () => randomInt(1, 2 ** 31 - 1);

/** `opts.now` is a test seam only: no route passes it, so production always uses the real clock. */
const start = async (actor: Actor, input: StartInput, opts: { now?: Date } = {}) => {
  if (!Types.ObjectId.isValid(input.doctorId)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid doctor id');
  const isUrgent = input.isUrgent === true;

  // 1. Presence is a Redis key, not the Mongo cache, and not a database transaction concern.
  if (!(await presenceService.isOnline(input.doctorId))) {
    throw new AppError(httpStatus.CONFLICT, 'This doctor is offline');
  }

  // 2. Attempt cooldown per patient (a patient must not be able to ring 40 doctors in two minutes).
  const slot = await cooldown(`call:cooldown:patient:${actor.userId}`, config.call_cooldown_seconds);
  if (!slot.acquired) {
    throw new AppError(httpStatus.TOO_MANY_REQUESTS, `Please wait ${slot.retryAfterSeconds} seconds before placing another call`);
  }

  const callId = new Types.ObjectId();
  const channelName = `call_${callId}`;
  setCallId(String(callId));

  let created;
  try {
    created = await runInTransaction(async (session) => {
      const now = opts.now ?? new Date();
      const doctor = await Doctor.findById(input.doctorId).session(session);
      if (!doctor || doctor.approvalStatus !== DOCTOR_APPROVAL_STATUS.APPROVED) {
        throw new AppError(httpStatus.NOT_FOUND, 'Doctor not found');
      }
      if (String(doctor.userId) === actor.userId) throw new AppError(httpStatus.BAD_REQUEST, 'You cannot call yourself');
      const doctorUser = await User.findById(doctor.userId).select('phoneVerified status').session(session).lean();
      if (!doctorUser || doctorUser.status !== 'active' || !doctorUser.phoneVerified) {
        throw new AppError(httpStatus.CONFLICT, 'This doctor is not available');
      }

      const settings = await loadSettings(session);

      // 3. The rate, fixed ONCE, here. Urgent: PlatformSetting only, no fallback. Normal: the doctor's own.
      let timeSlot;
      let ratePaisePerMin: number;
      if (isUrgent) {
        ({ timeSlot, ratePaisePerMin } = await resolveUrgentCallRate(now, session));
      } else {
        timeSlot = resolveTimeSlot(now, settings.dayStartTime, settings.nightStartTime);
        const rate = timeSlot === 'day' ? doctor.consultationRateDayPaise : doctor.consultationRateNightPaise;
        if (!isValidRatePaise(rate)) throw new AppError(httpStatus.UNPROCESSABLE_ENTITY, 'This doctor is not available for calls');
        ratePaisePerMin = rate;
      }

      // 4. The balance, from the LEDGER, inside the session.
      const balancePaise = await walletService.getBalance(actor.userId, session);
      if (balancePaise < settings.minWalletPaise) {
        throw new AppError(httpStatus.PAYMENT_REQUIRED, 'Your wallet balance is too low to start a call. Please top up.');
      }

      // 5. As if the call WILL be charged. Never assume it may turn out free.
      const maxAffordableSeconds = computeMaxAffordableSeconds(balancePaise, ratePaisePerMin);
      if (maxAffordableSeconds < 60) {
        throw new AppError(httpStatus.PAYMENT_REQUIRED, 'Your wallet balance does not cover one minute of this call. Please top up.');
      }

      const commissionPercentSnapshot = doctor.commissionPercent ?? settings.commissionPct;
      const agoraUidPatient = randomUid();
      let agoraUidDoctor = randomUid();
      while (agoraUidDoctor === agoraUidPatient) agoraUidDoctor = randomUid();

      // 6. Insert. The partial unique indexes make a busy doctor an E11000 (mapped below).
      const [call] = await Call.create(
        [
          {
            _id: callId,
            patientId: actor.userId,
            doctorId: doctor._id,
            status: CALL_STATUS.RINGING,
            timeSlot,
            isUrgent,
            ratePaisePerMin,
            maxAffordableSeconds,
            commissionPercentSnapshot,
            agoraChannelName: channelName,
            agoraUidPatient: String(agoraUidPatient),
            agoraUidDoctor: String(agoraUidDoctor),
          },
        ],
        { session },
      );
      return { call, doctorUserId: String(doctor.userId), agoraUidPatient, balancePaise };
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      const pattern = (err as { keyPattern?: Record<string, unknown> }).keyPattern ?? {};
      if ('patientId' in pattern) throw new AppError(httpStatus.CONFLICT, 'You already have a call in progress');
      throw new AppError(httpStatus.CONFLICT, 'This doctor is busy with another call');
    }
    throw err;
  }

  // ---- committed. Everything below is outside the session. ----
  const { call, doctorUserId, agoraUidPatient } = created;

  // 7. The patient's token, scoped to this channel and uid, expiring just past the affordable
  //    duration (plus the ringing window, since the clock starts when the call is placed).
  let token: string;
  try {
    token = getAgoraClient().mintRtcToken({
      channelName,
      uid: agoraUidPatient,
      ttlSeconds: call.maxAffordableSeconds + config.agora.tokenGraceSeconds + RING_TIMEOUT_SECONDS,
    });
  } catch (err) {
    // Without a token the call is unusable. Release the in-flight slot or the doctor is blocked.
    await Call.updateOne(
      { _id: call._id, status: CALL_STATUS.RINGING },
      { $set: { status: CALL_STATUS.FAILED, endReason: CALL_END_REASON.SYSTEM_ERROR, endedAt: new Date() } },
    );
    throw err;
  }

  // 8. Tell the doctor: high priority push + socket event. Best effort, both.
  const patient = await User.findById(actor.userId).select('name').lean();
  const incoming = { callId: String(call._id), channelName, patientName: patient?.name ?? '', isUrgent };
  void notifyIncoming(doctorUserId, incoming);

  // 9. 30 s ringing timeout. If this cannot be queued the sweep moves the call to missed.
  await tryJob('ringing-timeout', (j) => j.scheduleRingingTimeout(String(call._id)));

  return {
    callId: String(call._id),
    status: call.status,
    channelName,
    agoraAppId: config.agora.appId,
    agoraUid: agoraUidPatient,
    agoraToken: token,
    timeSlot: call.timeSlot,
    isUrgent,
    ratePaisePerMin: call.ratePaisePerMin,
    maxAffordableSeconds: call.maxAffordableSeconds,
    ringTimeoutSeconds: RING_TIMEOUT_SECONDS,
  };
};

const notifyIncoming = async (doctorUserId: string, payload: { callId: string; channelName: string; patientName: string; isUrgent: boolean }) => {
  emitToUser(doctorUserId, 'call:incoming', payload);
  const tokens = (await DeviceToken.find({ userId: doctorUserId }).select('token').lean()).map((t) => t.token);
  await trySendPush(tokens, { type: 'call_incoming', callId: payload.callId, channelName: payload.channelName, patientName: payload.patientName, isUrgent: String(payload.isUrgent) });
};

// ------------------------------------------------------- doctor's responses

const doctorOf = async (actor: Actor) => {
  const doctor = await Doctor.findOne({ userId: actor.userId }).select('_id userId').lean();
  if (!doctor) throw new AppError(httpStatus.FORBIDDEN, 'Only a doctor can respond to a call');
  return doctor;
};

/** Ownership by the token subject: the call must be addressed to THIS doctor. */
const accept = async (actor: Actor, callId: string) => {
  if (!Types.ObjectId.isValid(callId)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid call id');
  setCallId(callId);
  const doctor = await doctorOf(actor);
  const now = new Date();
  const call = await Call.findOneAndUpdate(
    { _id: callId, doctorId: doctor._id, status: CALL_STATUS.RINGING },
    { $set: { status: CALL_STATUS.ACTIVE, answeredAt: now, startedAt: now } },
    { new: true },
  );
  if (!call) {
    const exists = await Call.exists({ _id: callId, doctorId: doctor._id });
    throw exists
      ? new AppError(httpStatus.CONFLICT, 'This call is no longer ringing')
      : new AppError(httpStatus.NOT_FOUND, 'Call not found');
  }

  const token = getAgoraClient().mintRtcToken({
    channelName: call.agoraChannelName,
    uid: Number(call.agoraUidDoctor),
    ttlSeconds: call.maxAffordableSeconds + config.agora.tokenGraceSeconds,
  });
  armCallTimers({
    _id: call._id,
    patientId: call.patientId,
    doctorUserId: String(doctor.userId),
    maxAffordableSeconds: call.maxAffordableSeconds,
    startedAt: now,
  });
  emitToUser(String(call.patientId), 'call:accepted', { callId });

  return {
    callId,
    status: call.status,
    channelName: call.agoraChannelName,
    agoraAppId: config.agora.appId,
    agoraUid: Number(call.agoraUidDoctor),
    agoraToken: token,
    maxAffordableSeconds: call.maxAffordableSeconds,
  };
};

const reject = async (actor: Actor, callId: string) => {
  if (!Types.ObjectId.isValid(callId)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid call id');
  setCallId(callId);
  const doctor = await doctorOf(actor);
  const call = await Call.findOneAndUpdate(
    { _id: callId, doctorId: doctor._id, status: CALL_STATUS.RINGING },
    { $set: { status: CALL_STATUS.REJECTED, endReason: CALL_END_REASON.DOCTOR_REJECTED, endedAt: new Date() } },
    { new: true },
  );
  if (!call) {
    const exists = await Call.exists({ _id: callId, doctorId: doctor._id });
    throw exists
      ? new AppError(httpStatus.CONFLICT, 'This call is no longer ringing')
      : new AppError(httpStatus.NOT_FOUND, 'Call not found');
  }
  emitToUser(String(call.patientId), 'call:rejected', { callId });
  return { callId, status: call.status };
};

/** ringing -> missed. Idempotent; the job and the sweep both call it. */
const markMissed = async (callId: string): Promise<boolean> => {
  setCallId(callId);
  const call = await Call.findOneAndUpdate(
    { _id: callId, status: CALL_STATUS.RINGING },
    { $set: { status: CALL_STATUS.MISSED, endReason: CALL_END_REASON.DOCTOR_MISSED, endedAt: new Date() } },
    { new: true },
  );
  if (!call) return false; // it moved on; nothing to do
  emitToUser(String(call.patientId), 'call:missed', { callId });
  const doctor = await Doctor.findById(call.doctorId).select('userId').lean();
  if (doctor) emitToUser(String(doctor.userId), 'call:missed', { callId });
  return true;
};

/**
 * "I ended the call" from either app. A HINT that an end is expected: it changes no state and
 * carries no duration. It only asks the system to look at the Agora events soon.
 */
const requestEnd = async (actor: Actor, callId: string) => {
  if (!Types.ObjectId.isValid(callId)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid call id');
  const call = await Call.findById(callId).select('patientId doctorId status').lean();
  if (!call) throw new AppError(httpStatus.NOT_FOUND, 'Call not found');
  const doctor = await Doctor.findOne({ userId: actor.userId }).select('_id').lean();
  const isParticipant = String(call.patientId) === actor.userId || (doctor && String(call.doctorId) === String(doctor._id));
  if (!isParticipant) throw new AppError(httpStatus.NOT_FOUND, 'Call not found'); // do not reveal other users' calls
  if (call.status === CALL_STATUS.ACTIVE) {
    await tryJob('finalize-hint', (j) => j.scheduleFinalize(callId, `hint-${Date.now()}`, FINALIZE_DELAY_MS));
  }
  return { callId, accepted: true };
};

// ---------------------------------------------------------------- finalize (6B)

export type FinalizeOutcome = 'billed' | 'free' | 'failed' | 'noop' | 'unaffordable';

const toPresenceEvents = (rows: Array<{ uid: string; eventType: string; eventTs: Date; raw?: unknown }>): PresenceEvent[] =>
  rows.map((r) => {
    const seq = (r.raw as { payload?: { clientSeq?: unknown } } | undefined)?.payload?.clientSeq;
    return { uid: r.uid, eventType: r.eventType, eventTs: r.eventTs, clientSeq: typeof seq === 'number' ? seq : null };
  });

/**
 * End a call and bill it, ONE session. Triggered after Agora leave events (and by the sweep);
 * the duration is derived from those events, never taken from a client. Idempotent: a call that
 * is no longer `active` is left alone.
 */
const finalize = async (callId: string, now: Date = new Date()): Promise<FinalizeOutcome> => {
  setCallId(callId);
  let result: Awaited<ReturnType<typeof finalizeInSession>>;
  try {
    result = await runInTransaction((session) => finalizeInSession(callId, now, session));
  } catch (err) {
    if ((err as AppError)?.statusCode === httpStatus.PAYMENT_REQUIRED) {
      // The charge cannot be taken although the duration was capped at the affordable one. That
      // is an anomaly, not a billing rule: close the call with no money and let an admin decide.
      await closeWithoutBilling(callId, CALL_END_REASON.SYSTEM_ERROR, 'call_charge_unaffordable');
      return 'unaffordable';
    }
    throw err;
  }
  if (result.outcome === 'noop') return 'noop';

  clearCallTimers(callId);
  emitToUser(result.patientUserId, 'call:ended', result.summary);
  if (result.doctorUserId) emitToUser(result.doctorUserId, 'call:ended', result.summary);

  if (result.outcome === 'billed' && result.prescriptionDelays) {
    // Paid calls only. A free call queues NO jobs.
    await tryJob('prescription-jobs', (j) =>
      j.schedulePrescriptionJobs(callId, result.prescriptionDelays!.reminderMs, result.prescriptionDelays!.expiryMs),
    );
  }
  return result.outcome;
};

const finalizeInSession = async (callId: string, now: Date, session: ClientSession) => {
  const noop = { outcome: 'noop' as const };
  const call = await Call.findById(callId).session(session);
  if (!call || call.status !== CALL_STATUS.ACTIVE) return noop;

  const rows = await AgoraCallEvent.find({ callId: call._id }).session(session).lean();
  const presence = analyseCallPresence(toPresenceEvents(rows), { patient: call.agoraUidPatient, doctor: call.agoraUidDoctor });
  if (presence.state === 'unknown') return noop; // still going, or no end event yet: NEVER guess

  const doctor = await Doctor.findById(call.doctorId).select('userId payoutMode').session(session).lean();
  const summaryBase = { callId, isFreeShortCall: false };

  // Someone left but they were never in the channel together: no conversation, no money, and
  // no allowance consumed.
  if (presence.state === 'never_connected') {
    const r = await Call.updateOne(
      { _id: call._id, status: CALL_STATUS.ACTIVE },
      { $set: { status: CALL_STATUS.FAILED, endReason: CALL_END_REASON.SYSTEM_ERROR, endedAt: now, durationSeconds: 0, billedMinutes: 0, grossPaise: 0, commissionPaise: 0, netPaise: 0, isFreeShortCall: false, prescriptionStatus: PRESCRIPTION_STATUS.NOT_REQUIRED } },
      { session },
    );
    if (r.modifiedCount !== 1) return noop;
    return { outcome: 'failed' as const, patientUserId: String(call.patientId), doctorUserId: doctor ? String(doctor.userId) : null, summary: { ...summaryBase, status: CALL_STATUS.FAILED, durationSeconds: 0, grossPaise: 0 }, prescriptionDelays: null };
  }

  const settings = await loadSettings(session);
  const durationSeconds = presence.durationSeconds;
  // Never bill beyond the duration the patient could afford (a failed cut-off must not push
  // the balance negative). ASSUMPTION: the platform absorbs time past the affordable limit.
  const billableSeconds = Math.min(durationSeconds, call.maxAffordableSeconds);

  // The free short-call allowance. A duplicate-key error INSIDE a transaction aborts the whole
  // transaction, so the plan's insert-and-catch cannot work here. Instead: look, then insert.
  // Two handlers racing for one pair both look, both insert, and the second hits a write
  // conflict, re-runs, and then SEES the allowance. The insert is in the session, so an aborted
  // transaction releases it.
  let isFree = false;
  if (billableSeconds < 60) {
    const spent = await ShortCallAllowance.exists({ patientId: call.patientId, doctorId: call.doctorId }).session(session);
    if (!spent) {
      await ShortCallAllowance.create([{ patientId: call.patientId, doctorId: call.doctorId, callId: call._id }], { session });
      isFree = true;
    }
  }

  const billing = resolveBilling({
    durationSeconds: billableSeconds,
    isFree,
    ratePaisePerMin: call.ratePaisePerMin,
    commissionPercent: call.commissionPercentSnapshot,
  });

  const lowBalance = call.endReason === CALL_END_REASON.LOW_BALANCE;
  const endReason = call.endReason ?? (presence.firstLeaver === 'patient' ? CALL_END_REASON.PATIENT_ENDED : CALL_END_REASON.DOCTOR_ENDED);
  const status = lowBalance ? CALL_STATUS.ENDED_LOW_BALANCE : CALL_STATUS.COMPLETED;
  const paid = billing.grossPaise > 0;

  const deadline = new Date(now.getTime() + settings.prescriptionWindowMinutes * 60_000);
  const update = await Call.updateOne(
    { _id: call._id, status: CALL_STATUS.ACTIVE },
    {
      $set: {
        status,
        endReason,
        endedAt: now,
        durationSeconds,
        billedMinutes: billing.billedMinutes,
        grossPaise: billing.grossPaise,
        commissionPaise: billing.commissionPaise,
        netPaise: billing.netPaise,
        isFreeShortCall: isFree,
        prescriptionStatus: paid ? PRESCRIPTION_STATUS.PENDING : PRESCRIPTION_STATUS.NOT_REQUIRED,
        prescriptionDeadlineAt: paid ? deadline : null,
      },
    },
    { session },
  );
  if (update.modifiedCount !== 1) return noop;

  if (paid) {
    // Ledger debit + wallet cache (walletService.append), the call fields above, and the
    // DoctorEarning below all commit together or not at all.
    await walletService.append(session, {
      userId: call.patientId,
      type: WALLET_LEDGER_TYPE.CALL_CHARGE,
      direction: WALLET_LEDGER_DIRECTION.DEBIT,
      amountPaise: billing.grossPaise,
      idempotencyKey: chargeKey(callId),
      referenceType: 'call',
      referenceId: call._id,
      description: `Call charge: ${billing.billedMinutes} min`,
      metadata: { durationSeconds, billedMinutes: billing.billedMinutes, ratePaisePerMin: call.ratePaisePerMin },
    });

    // A retainer doctor is paid another way: no earning row.
    if (doctor && doctor.payoutMode !== 'retainer') {
      await DoctorEarning.create(
        [
          {
            callId: call._id,
            doctorId: call.doctorId,
            grossPaise: billing.grossPaise,
            commissionPaise: billing.commissionPaise,
            netPaise: billing.netPaise,
            status: DOCTOR_EARNING_STATUS.HELD,
            heldAt: now,
          },
        ],
        { session },
      );
    }
  }
  // A free call: NO ledger entry, NO earning, NO jobs, prescriptionStatus = not_required.

  return {
    outcome: (paid ? 'billed' : 'free') as 'billed' | 'free',
    patientUserId: String(call.patientId),
    doctorUserId: doctor ? String(doctor.userId) : null,
    summary: { ...summaryBase, status, durationSeconds, billedMinutes: billing.billedMinutes, grossPaise: billing.grossPaise, isFreeShortCall: isFree },
    prescriptionDelays: paid ? { reminderMs: settings.reminderMinutes * 60_000, expiryMs: settings.prescriptionWindowMinutes * 60_000 } : null,
  };
};

// ----------------------------------------------------------------- cut-off & orphans

/**
 * The affordable duration has been reached (timer, or the sweep after an API restart). Marks
 * the reason so finalize records `ended_low_balance`, then removes both parties from the
 * channel. The Agora leave events that follow end the call through finalize.
 */
const cutOff = async (callId: string): Promise<boolean> => {
  setCallId(callId);
  const call = await Call.findOneAndUpdate(
    { _id: callId, status: CALL_STATUS.ACTIVE, endReason: null },
    { $set: { endReason: CALL_END_REASON.LOW_BALANCE } },
    { new: true },
  );
  const current = call ?? (await Call.findOne({ _id: callId, status: CALL_STATUS.ACTIVE }));
  if (!current) return false;
  return tryCloseChannel({
    channelName: current.agoraChannelName,
    uids: [Number(current.agoraUidPatient), Number(current.agoraUidDoctor)],
  });
};

/** Close with no money. Used for an anomaly, and by the sweep's no-end-event condition. */
const closeWithoutBilling = async (callId: string, endReason: string, findingName: string, severity: 'critical' | 'warning' = 'critical') => {
  const r = await Call.findOneAndUpdate(
    { _id: callId, status: CALL_STATUS.ACTIVE },
    {
      $set: {
        status: CALL_STATUS.COMPLETED,
        endReason,
        endedAt: new Date(),
        durationSeconds: 0,
        billedMinutes: 0,
        grossPaise: 0,
        commissionPaise: 0,
        netPaise: 0,
        isFreeShortCall: false,
        prescriptionStatus: PRESCRIPTION_STATUS.NOT_REQUIRED,
        prescriptionDeadlineAt: null,
      },
    },
    { new: true },
  );
  if (!r) return false;
  clearCallTimers(callId);
  await ReconciliationFinding.create({
    runAt: new Date(),
    checkName: findingName,
    severity,
    entityType: 'Call',
    entityId: r._id,
    detail: { callId, patientId: String(r.patientId), doctorId: String(r.doctorId), endReason },
  });
  logger.error({ callId, endReason, findingName }, 'call closed with no money written; an admin must review');
  return true;
};

/**
 * Sweep condition B. The Agora end event never arrived and the call is far past its affordable
 * duration. The call MUST be closed, because `active` holds the doctor's partial unique index
 * and would block that doctor from every future call.
 *
 * TODO(client): this is NOT an approved billing rule. The billing treatment of a lost end event
 * has not been confirmed. Closing the call is a technical necessity; writing no money is a
 * DEFERRAL to an admin (critical ReconciliationFinding), not a decision that the call is free.
 * Do not promote this to a billing rule without explicit client confirmation.
 */
const closeNoEndEvent = async (callId: string): Promise<boolean> => {
  setCallId(callId);
  const call = await Call.findById(callId).lean();
  if (!call || call.status !== CALL_STATUS.ACTIVE) return false;
  const rows = await AgoraCallEvent.find({ callId: call._id }).lean();
  const presence = analyseCallPresence(toPresenceEvents(rows), { patient: call.agoraUidPatient, doctor: call.agoraUidDoctor });
  if (presence.state !== 'unknown') return false; // a duration CAN be derived: finalize handles it
  return closeWithoutBilling(callId, CALL_END_REASON.NO_END_EVENT, 'call_no_end_event');
};

// ---------------------------------------------------------------------- reads

const publicFields =
  'patientId doctorId status endReason timeSlot isUrgent ratePaisePerMin maxAffordableSeconds startedAt answeredAt endedAt durationSeconds billedMinutes isFreeShortCall grossPaise commissionPaise netPaise prescriptionStatus prescriptionDeadlineAt createdAt';

const scopeFor = async (actor: Actor): Promise<Record<string, unknown> | null> => {
  if (actor.role === 'admin') return {};
  if (actor.role === 'doctor') {
    const doctor = await Doctor.findOne({ userId: actor.userId }).select('_id').lean();
    return doctor ? { doctorId: doctor._id } : null;
  }
  return { patientId: actor.userId };
};

/** Call history. Carries isFreeShortCall so both apps can label a free call. */
const list = async (actor: Actor, page: number, limit: number) => {
  const scope = await scopeFor(actor);
  if (!scope) return { rows: [], meta: { page, limit, total: 0, totalPage: 1 } };
  const [total, rows] = await Promise.all([
    Call.countDocuments(scope),
    Call.find(scope).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select(publicFields).lean(),
  ]);
  return { rows, meta: { page, limit, total, totalPage: Math.max(1, Math.ceil(total / limit)) } };
};

const getOne = async (actor: Actor, callId: string) => {
  if (!Types.ObjectId.isValid(callId)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid call id');
  const scope = await scopeFor(actor);
  const call = scope ? await Call.findOne({ _id: callId, ...scope }).select(publicFields).lean() : null;
  if (!call) throw new AppError(httpStatus.NOT_FOUND, 'Call not found'); // other users' calls look absent
  return call;
};

export const callService = {
  start,
  accept,
  reject,
  markMissed,
  requestEnd,
  finalize,
  cutOff,
  closeNoEndEvent,
  closeWithoutBilling,
  list,
  getOne,
};
