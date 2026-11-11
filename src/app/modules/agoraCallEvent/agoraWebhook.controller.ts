// POST /api/v1/webhooks/agora/call
//
// 1. VERIFY THE SIGNATURE on the raw body before anything else. An unverified payload is logged
//    and dropped. A forged "leave" event would be a free consultation.
// 2. Persist the event to AgoraCallEvent BEFORE any derivation. The unique providerEventId makes a
//    duplicate delivery a no-op.
// 3. Then ask for the call to be finalized (a short delayed job). Nothing is billed here.
//
// providerEventId (the open question B1): Agora's docs do not say noticeId is unique per event or
// stable across retries, and the only documented per-event sequence is payload.clientSeq. So the
// id is `channelName:uid:eventType:clientSeq`. A retry of one event carries the same four values,
// so it deduplicates; distinct events differ in at least the sequence. noticeId is kept in `raw`.
// If clientSeq is absent, noticeId is used. VERIFY AGAINST A REAL DELIVERY.
//
// Event types persisted: 103-108 (join / leave in streaming and communication profiles). Channel
// create / destroy (101, 102) and role changes (111, 112) are acknowledged and ignored.
// Agora needs a 200 with a JSON body within 10 seconds, so the work here is kept small.
import { Request, Response } from 'express';
import httpStatus from 'http-status';
import config from '../../config';
import AppError from '../../error/AppError';
import catchAsync from '../../utils/catchAsync';
import { logger } from '../../../shared/logger';
import { setCallId } from '../../../shared/requestContext';
import { verifyAgoraSignature } from '../../../shared/agora';
import { AgoraCallEvent } from './agoraCallEvent.model';
import { Call } from '../call/call.model';
import { CALL_STATUS } from '../call/call.constants';
import { JOIN_EVENT_TYPES, LEAVE_EVENT_TYPES } from '../call/deriveCallDuration';
import { tryJob } from '../call/call.jobs';

const RTC_PRODUCT_ID = 1;

export const agoraCallWebhook = catchAsync(async (req: Request, res: Response) => {
  const ok = verifyAgoraSignature(
    req.body,
    { v1: req.get('agora-signature') || undefined, v2: req.get('agora-signature-v2') || undefined },
    config.agora.webhookSecret,
  );
  if (!ok) {
    logger.warn(
      { bytes: Buffer.isBuffer(req.body) ? req.body.length : null, secretConfigured: !!config.agora.webhookSecret },
      'agora webhook rejected: signature not verified',
    );
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid signature');
  }

  let envelope: { noticeId?: string; productId?: number; eventType?: number; payload?: Record<string, unknown> };
  try {
    envelope = JSON.parse((req.body as Buffer).toString('utf8'));
  } catch {
    throw new AppError(httpStatus.BAD_REQUEST, 'Malformed body');
  }

  const eventType = String(envelope.eventType);
  const payload = envelope.payload ?? {};
  const ignored = (reason: string) => {
    logger.debug({ reason, eventType }, 'agora event ignored');
    res.status(httpStatus.OK).json({ success: true, message: 'ignored', data: { reason }, meta: null });
  };

  if (envelope.productId !== RTC_PRODUCT_ID) return ignored('not an RTC event');
  if (!JOIN_EVENT_TYPES.has(eventType) && !LEAVE_EVENT_TYPES.has(eventType)) return ignored('not a join or leave event');

  const channelName = payload.channelName;
  const uid = payload.uid;
  const ts = payload.ts;
  if (typeof channelName !== 'string' || (typeof uid !== 'number' && typeof uid !== 'string') || typeof ts !== 'number') {
    return ignored('missing channelName, uid or ts');
  }

  const call = await Call.findOne({ agoraChannelName: channelName }).select('_id status agoraUidPatient agoraUidDoctor').lean();
  if (!call) return ignored('unknown channel'); // includes Agora's own "test_webhook"
  setCallId(String(call._id));
  const uidStr = String(uid);
  // Only the two parties of this call count. A recording bot or any other uid is not a party.
  if (uidStr !== call.agoraUidPatient && uidStr !== call.agoraUidDoctor) return ignored('uid is not a party of the call');

  const clientSeq = payload.clientSeq;
  const providerEventId =
    typeof clientSeq === 'number' ? `${channelName}:${uidStr}:${eventType}:${clientSeq}` : `notice:${envelope.noticeId ?? 'unknown'}`;

  try {
    await AgoraCallEvent.create({
      callId: call._id,
      channelName,
      uid: uidStr,
      eventType,
      eventTs: new Date(ts * 1000), // payload.ts is in SECONDS
      providerEventId,
      raw: envelope,
    });
  } catch (err) {
    if ((err as { code?: number }).code === 11000) {
      return void res.status(httpStatus.OK).json({ success: true, message: 'duplicate', data: { duplicate: true }, meta: null });
    }
    throw err; // a 5xx makes Agora retry, which is what we want for a storage failure
  }

  // A leave may end the call. Wait a few seconds first so a quick rejoin is not mistaken for the end.
  if (LEAVE_EVENT_TYPES.has(eventType) && call.status === CALL_STATUS.ACTIVE) {
    await tryJob('finalize', (j) => j.scheduleFinalize(String(call._id), providerEventId.replace(/[^A-Za-z0-9_-]/g, '-')));
  }

  res.status(httpStatus.OK).json({ success: true, message: 'ok', data: { stored: true }, meta: null });
});
