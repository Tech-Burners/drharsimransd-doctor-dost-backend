// The 30 second overdue-call sweep. ONE job, run by the worker only (never the API: it would
// then run once per API instance). It is the safety net under every other mechanism:
//
//   ringing too long                      -> missed        (the 30 s job was lost)
//   active, Agora events show it ended    -> finalize      (the finalize job was lost)
//   active, past maxAffordableSeconds     -> cut off       CONDITION A (timer lost to a restart)
//   active, past the hard ceiling and the duration cannot be derived
//                                         -> close, NO money, critical finding   CONDITION B
//
// Condition B exists because a call left `active` holds the partial unique index on doctorId and
// would block that doctor from every future call. It is a technical closure, NOT a billing
// decision (see callService.closeNoEndEvent).
import config from '../../config';
import { logger } from '../../../shared/logger';
import { Call } from './call.model';
import { CALL_STATUS } from './call.constants';
import { callService } from './call.service';
import { analyseCallPresence } from './deriveCallDuration';
import { RING_TIMEOUT_SECONDS } from './call.jobs';
import { AgoraCallEvent } from '../agoraCallEvent/agoraCallEvent.model';

const RINGING_GRACE_SECONDS = 15;
const BATCH = 200;

export interface SweepStats {
  missed: number;
  finalized: number;
  cutOff: number;
  closedNoEndEvent: number;
  errors: number;
}

export const runCallSweep = async (now: Date = new Date()): Promise<SweepStats> => {
  const stats: SweepStats = { missed: 0, finalized: 0, cutOff: 0, closedNoEndEvent: 0, errors: 0 };

  const staleRinging = await Call.find({
    status: CALL_STATUS.RINGING,
    createdAt: { $lt: new Date(now.getTime() - (RING_TIMEOUT_SECONDS + RINGING_GRACE_SECONDS) * 1000) },
  })
    .select('_id')
    .limit(BATCH)
    .lean();
  for (const c of staleRinging) {
    try {
      if (await callService.markMissed(String(c._id))) stats.missed += 1;
    } catch (err) {
      stats.errors += 1;
      logger.error({ err, callId: String(c._id) }, 'sweep: could not mark a call missed');
    }
  }

  const active = await Call.find({ status: CALL_STATUS.ACTIVE }).limit(BATCH).lean();
  for (const c of active) {
    const callId = String(c._id);
    try {
      const startedAt = c.startedAt ?? c.answeredAt;
      if (!startedAt) continue;
      const rows = await AgoraCallEvent.find({ callId: c._id }).lean();
      const presence = analyseCallPresence(
        rows.map((r) => {
          const seq = (r.raw as { payload?: { clientSeq?: unknown } } | undefined)?.payload?.clientSeq;
          return { uid: r.uid, eventType: r.eventType, eventTs: r.eventTs, clientSeq: typeof seq === 'number' ? seq : null };
        }),
        { patient: c.agoraUidPatient, doctor: c.agoraUidDoctor },
      );

      if (presence.state !== 'unknown') {
        if ((await callService.finalize(callId, now)) !== 'noop') stats.finalized += 1;
        continue;
      }

      const affordableEnd = startedAt.getTime() + c.maxAffordableSeconds * 1000;
      if (now.getTime() <= affordableEnd) continue; // within the affordable duration

      // Condition A: past what the patient can pay for. Normal cut-off.
      if (await callService.cutOff(callId)) stats.cutOff += 1;

      // Condition B: past the hard ceiling, and no way to derive a duration.
      const ceiling = affordableEnd + config.call_orphan_grace_seconds * 1000;
      if (now.getTime() > ceiling && (await callService.closeNoEndEvent(callId))) stats.closedNoEndEvent += 1;
    } catch (err) {
      stats.errors += 1;
      logger.error({ err, callId }, 'sweep: error handling an active call');
    }
  }
  return stats;
};
