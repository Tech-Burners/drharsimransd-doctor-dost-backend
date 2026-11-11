// Refunds: ONE shared, full-only, transactional code path, used by the admin endpoint and (in
// Phase 7) the prescription-expiry job. Both share the ledger key `call:<callId>:refund`, so a
// call is refunded at most once by either.
//
// Inside one session it:
//   1. credits the patient the FULL charge the ledger recorded for the call (no amount is
//      ever accepted; the original charge entry is untouched);
//   2. takes the call's DoctorEarning out of what the doctor can be paid:
//        held                       -> forfeited
//        released, unclaimed        -> reversed
//        released, in a PENDING     -> reversed, and the request is reduced by that amount
//          withdrawal request          (cancelled, a system status, if it reaches zero)
//        withdrawn / request PAID   -> reversed, and the doctor owes it back (recovery)
//      Only the doctor's NET earning is reversed or recovered. The platform absorbs its own
//      commission. The earning row is kept, and every change adds an append-only
//      DoctorLedgerAdjustment pointing at the earning and at the refund entry;
//   3. queues the patient and doctor notices in the outbox (delivered after commit).
// A refund is never blocked because of a withdrawal.
import httpStatus from 'http-status';
import { ClientSession, HydratedDocument, Types } from 'mongoose';
import AppError from '../../error/AppError';
import { runInTransaction } from '../../../shared/transaction';
import { Call } from '../call/call.model';
import { Doctor } from '../doctor/doctor.model';
import { DoctorEarning } from '../doctorEarning/doctorEarning.model';
import { TDoctorEarning } from '../doctorEarning/doctorEarning.interface';
import { DOCTOR_EARNING_STATUS as ES } from '../doctorEarning/doctorEarning.constants';
import { recoveryService } from '../doctorEarning/recovery.service';
import {
  DOCTOR_ADJUSTMENT_TYPE,
  DoctorLedgerAdjustment,
} from '../doctorLedgerAdjustment/doctorLedgerAdjustment.model';
import { OUTBOX_EVENT_TYPE } from '../outbox/outbox.model';
import { outboxService } from '../outbox/outbox.service';
import { walletService } from '../wallet/wallet.service';
import { WalletLedger } from '../wallet/walletLedger.model';
import { WALLET_LEDGER_DIRECTION, WALLET_LEDGER_TYPE } from '../wallet/walletLedger.constants';
import { WithdrawalRequest } from '../withdrawalRequest/withdrawalRequest.model';
import { WITHDRAWAL_REQUEST_STATUS as WS } from '../withdrawalRequest/withdrawalRequest.constants';

export const chargeKey = (callId: string) => `call:${callId}:charge`;
export const refundKey = (callId: string) => `call:${callId}:refund`;

export type RefundSource = 'admin' | 'prescription_expiry';

export interface RefundInput {
  callId: string;
  source: RefundSource;
  reason: string;
  note?: string;
  /** The admin's user id; null for the system (the expiry job). */
  refundedBy: string | null;
  /** Expiry path: also set the call's prescriptionStatus to 'expired' in the same session. */
  markPrescriptionExpired?: boolean;
}

export type EarningAction = 'none' | 'forfeited' | 'reversed';

export interface EarningOutcome {
  action: EarningAction;
  earningId: string | null;
  earningNetPaise: number;
  /** Net removed from what the doctor can be paid (0 when forfeited or nothing existed). */
  reversedPaise: number;
  /** Part of the reversal absorbed from money not yet paid out. */
  recoveredNowPaise: number;
  /** Part already paid out: the doctor owes this back. */
  newRecoveryPaise: number;
  totalOutstandingRecoveryPaise: number;
  withdrawalRequestId: string | null;
  withdrawalRequestReducedByPaise: number;
  withdrawalRequestCancelled: boolean;
}

export interface RefundResult {
  refundEntryId: string;
  callId: string;
  amountPaise: number;
  balanceAfterPaise: number;
  earning: EarningOutcome;
}

const noEarning = (): EarningOutcome => ({
  action: 'none',
  earningId: null,
  earningNetPaise: 0,
  reversedPaise: 0,
  recoveredNowPaise: 0,
  newRecoveryPaise: 0,
  totalOutstandingRecoveryPaise: 0,
  withdrawalRequestId: null,
  withdrawalRequestReducedByPaise: 0,
  withdrawalRequestCancelled: false,
});

type EarningDoc = HydratedDocument<TDoctorEarning>;

const settleEarning = async (
  session: ClientSession,
  earning: EarningDoc,
  refundEntry: { _id: Types.ObjectId },
  input: RefundInput,
): Promise<EarningOutcome> => {
  const net = earning.netPaise;
  const out = { ...noEarning(), earningId: String(earning._id), earningNetPaise: net };
  const now = new Date();

  // held: it was never payable, so it is forfeited, not reversed.
  if (earning.status === ES.HELD) {
    const res = await DoctorEarning.updateOne(
      { _id: earning._id, status: ES.HELD },
      { $set: { status: ES.FORFEITED, forfeitedAt: now } },
      { session },
    );
    if (res.modifiedCount !== 1) throw new AppError(httpStatus.CONFLICT, 'Earning changed during the refund');
    return { ...out, action: 'forfeited' };
  }

  // already out of the doctor's reach (an earlier forfeit or reversal): nothing to undo.
  if (earning.status === ES.FORFEITED || earning.status === ES.REVERSED) return out;

  // released or withdrawn: work out how much of it is still unpaid.
  let recovery = 0;
  let requestReducedBy = 0;
  let requestCancelled = false;
  const requestId = earning.withdrawalRequestId ? String(earning.withdrawalRequestId) : null;

  if (earning.status === ES.WITHDRAWN) {
    recovery = net;
  } else if (earning.withdrawalRequestId) {
    const request = await WithdrawalRequest.findById(earning.withdrawalRequestId).session(session);
    if (request?.status === WS.PAID) {
      recovery = net; // the money has gone out
    } else if (request?.status === WS.PENDING) {
      // A refund is never blocked by a withdrawal. The request can be smaller than the earnings
      // it claims (Phase 7 funds payout PLUS the recovery it settles), so reduce by what the
      // request actually pays, never below zero.
      requestReducedBy = Math.min(net, request.amountPaise);
      const left = request.amountPaise - requestReducedBy;
      requestCancelled = left === 0;
      const r = await WithdrawalRequest.updateOne(
        { _id: request._id, status: WS.PENDING, amountPaise: request.amountPaise },
        {
          $set: {
            amountPaise: left,
            ...(requestCancelled && {
              status: WS.CANCELLED,
              rejectionReason: 'Every earning funding this request was refunded',
              decidedAt: now,
            }),
          },
        },
        { session },
      );
      if (r.modifiedCount !== 1) throw new AppError(httpStatus.CONFLICT, 'Withdrawal request changed during the refund');
    }
    // rejected or missing request: a dangling claim, treated as unclaimed released money.
  }

  const res = await DoctorEarning.updateOne(
    { _id: earning._id, status: earning.status },
    { $set: { status: ES.REVERSED, reversedAt: now, recoveryPaise: recovery } },
    { session },
  );
  if (res.modifiedCount !== 1) throw new AppError(httpStatus.CONFLICT, 'Earning changed during the refund');

  const base = {
    doctorId: earning.doctorId,
    earningId: earning._id,
    callId: earning.callId,
    refundLedgerEntryId: refundEntry._id,
    createdBy: input.refundedBy,
  };
  const adjustments: Array<Record<string, unknown>> = [
    {
      ...base,
      type: DOCTOR_ADJUSTMENT_TYPE.EARNING_REVERSAL,
      amountPaise: net,
      withdrawalRequestId: earning.withdrawalRequestId ?? null,
      idempotencyKey: `earning:${earning._id}:reversal`,
      note: `Refund (${input.source}): ${input.reason}`,
      metadata: { fromStatus: earning.status, requestReducedByPaise: requestReducedBy, requestCancelled },
    },
  ];
  if (recovery > 0) {
    adjustments.push({
      ...base,
      type: DOCTOR_ADJUSTMENT_TYPE.RECOVERY_RECORDED,
      amountPaise: recovery,
      withdrawalRequestId: earning.withdrawalRequestId ?? null,
      idempotencyKey: `earning:${earning._id}:recovery`,
      note: 'Already paid out: to be recovered from future withdrawals',
    });
  }
  await DoctorLedgerAdjustment.create(adjustments, { session, ordered: true });

  return {
    ...out,
    action: 'reversed',
    reversedPaise: net,
    recoveredNowPaise: net - recovery,
    newRecoveryPaise: recovery,
    withdrawalRequestId: requestId,
    withdrawalRequestReducedByPaise: requestReducedBy,
    withdrawalRequestCancelled: requestCancelled,
  };
};

/**
 * The refund, inside the CALLER's session. Throws E11000 (idempotency key) if the call was
 * already refunded; nothing else of this function has then been committed.
 *
 * Everything it decides on is read here, inside the session, never before it: a prescription
 * submit or a withdrawal request can change the earning at the same moment. All of them write
 * the same DoctorEarning document, so a write conflict makes the loser re-run on a fresh
 * snapshot. The callback touches only the database (it is re-run on a transient error).
 */
export const refundCallInSession = async (session: ClientSession, input: RefundInput): Promise<RefundResult> => {
  const call = await Call.findById(input.callId).select('_id patientId doctorId').session(session).lean();
  if (!call) throw new AppError(httpStatus.NOT_FOUND, 'Call not found');

  // The ledger, not the call document, says what was charged.
  const charge = await WalletLedger.findOne({ idempotencyKey: chargeKey(input.callId) }).session(session).lean();
  if (!charge) throw new AppError(httpStatus.CONFLICT, 'This call has no charge to refund');
  if (String(charge.userId) !== String(call.patientId)) {
    throw new AppError(httpStatus.CONFLICT, 'The recorded charge does not belong to the call patient');
  }

  // 1. The patient gets the whole charge back. The unique key makes a second refund impossible.
  const refund = await walletService.append(session, {
    userId: charge.userId,
    type: WALLET_LEDGER_TYPE.REFUND,
    direction: WALLET_LEDGER_DIRECTION.CREDIT,
    amountPaise: charge.amountPaise,
    idempotencyKey: refundKey(input.callId),
    referenceType: 'call',
    referenceId: call._id,
    description: `Refund: ${input.reason}`,
    metadata: {
      source: input.source,
      reason: input.reason,
      note: input.note ?? '',
      refundedBy: input.refundedBy,
      chargeEntryId: String(charge._id),
    },
  });

  // 2. The doctor's side.
  const earningDoc = await DoctorEarning.findOne({ callId: call._id }).session(session);
  const earning = earningDoc ? await settleEarning(session, earningDoc, refund, input) : noEarning();
  earning.totalOutstandingRecoveryPaise = await recoveryService.outstandingForDoctor(call.doctorId, session);

  if (input.markPrescriptionExpired) {
    await Call.updateOne({ _id: call._id, prescriptionStatus: 'pending' }, { $set: { prescriptionStatus: 'expired' } }, { session });
  }

  // 3. Notices, queued in this session so they exist if and only if the money moved.
  const doctor = await Doctor.findById(call.doctorId).select('userId').session(session).lean();
  const reference = refundKey(input.callId);
  await outboxService.addEvents(session, [
    {
      type: OUTBOX_EVENT_TYPE.REFUND_PATIENT_NOTICE,
      dedupeKey: `${reference}:patient`,
      payload: {
        userId: String(call.patientId),
        callId: input.callId,
        amountPaise: refund.amountPaise,
        status: 'completed',
        reference,
        refundEntryId: String(refund._id),
      },
    },
    ...(doctor
      ? [
          {
            type: OUTBOX_EVENT_TYPE.REFUND_DOCTOR_NOTICE,
            dedupeKey: `${reference}:doctor`,
            payload: {
              userId: String(doctor.userId),
              callId: input.callId,
              earningId: earning.earningId,
              action: earning.action,
              earningNetPaise: earning.earningNetPaise,
              reversedPaise: earning.reversedPaise,
              recoveredNowPaise: earning.recoveredNowPaise,
              newRecoveryPaise: earning.newRecoveryPaise,
              totalOutstandingRecoveryPaise: earning.totalOutstandingRecoveryPaise,
              withdrawalRequestReducedByPaise: earning.withdrawalRequestReducedByPaise,
              withdrawalRequestCancelled: earning.withdrawalRequestCancelled,
            },
          },
        ]
      : []),
  ]);

  return {
    refundEntryId: String(refund._id),
    callId: input.callId,
    amountPaise: refund.amountPaise,
    balanceAfterPaise: refund.balanceAfterPaise,
    earning,
  };
};

/** Admin entry point. A second refund of the same call is a 409. */
const refundCall = async (
  actor: { userId: string },
  input: { callId: string; reason: string; note?: string },
): Promise<RefundResult> => {
  if (!Types.ObjectId.isValid(input.callId)) throw new AppError(httpStatus.BAD_REQUEST, 'Invalid call id');
  try {
    return await runInTransaction((session) =>
      refundCallInSession(session, { ...input, source: 'admin', refundedBy: actor.userId }),
    );
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      throw new AppError(httpStatus.CONFLICT, 'This call has already been refunded');
    }
    throw err;
  }
};

/**
 * Expiry-job entry point (Phase 7 will call it). Already refunded is a success, not an error:
 * an admin may have refunded first, and the job must be safely repeatable.
 */
const refundCallForExpiry = async (callId: string): Promise<RefundResult | { alreadyRefunded: true }> => {
  try {
    return await runInTransaction((session) =>
      refundCallInSession(session, {
        callId,
        source: 'prescription_expiry',
        reason: 'Prescription not submitted in time',
        refundedBy: null,
        markPrescriptionExpired: true,
      }),
    );
  } catch (err) {
    if ((err as { code?: number }).code === 11000) return { alreadyRefunded: true };
    throw err;
  }
};

export const refundService = { refundCall, refundCallForExpiry };
