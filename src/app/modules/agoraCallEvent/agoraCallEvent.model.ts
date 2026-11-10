// Raw Agora channel join/leave events. Agora delivers events, not a duration; duration
// is DERIVED from these rows. A duplicate delivery is a no-op via the unique index.
// No soft delete.
//
// OPEN / UNCONFIRMED: providerEventId.
// Per the Agora page "Receive notifications about channel events", the request envelope
// is { noticeId, productId, eventType, notifyMs, payload }. noticeId is documented only
// as "the notification ID". The docs do NOT state that it is unique per event or identical
// across retries (Agora "can send more than one notification callback for each channel
// event"), and the docs' own ordering/dedupe guidance uses payload.clientSeq per user
// (absent on events 101 and 102). The source of providerEventId is therefore NOT
// finalised. Decide it in the Phase 6 webhook ingestion and verify it against a real
// delivery. Do not guess.
// Also: Agora sends eventType and uid as Numbers. They are stored as String here per the
// plan, so the ingestion layer must convert.
import { model, Schema } from 'mongoose';
import { TAgoraCallEvent, AgoraCallEventModel } from './agoraCallEvent.interface';

const agoraCallEventSchema = new Schema<TAgoraCallEvent, AgoraCallEventModel>(
  {
    callId: { type: Schema.Types.ObjectId, ref: 'Call', required: true },
    channelName: { type: String, required: true },
    uid: { type: String, required: true },
    eventType: { type: String, required: true },
    eventTs: { type: Date, required: true },
    providerEventId: { type: String, required: true },
    raw: { type: Schema.Types.Mixed, required: true },
    receivedAt: { type: Date, default: Date.now },
  },
  { strict: true },
);

agoraCallEventSchema.index({ callId: 1, eventTs: 1 });
agoraCallEventSchema.index({ providerEventId: 1 }, { unique: true });

export const AgoraCallEvent = model<TAgoraCallEvent, AgoraCallEventModel>(
  'AgoraCallEvent',
  agoraCallEventSchema,
);
