// Transactional outbox. A business transaction (a refund) inserts its events in the SAME
// session as the money change, so "money moved" and "tell the user" commit or abort together.
// A worker delivers them after commit, with retries. External calls never run inside a
// transaction.
//
// Duplicate prevention: dedupeKey is unique, so a re-run or retried transaction cannot queue
// the same notification twice, and handlers are idempotent on the event id.
import { model, Schema, Model } from 'mongoose';

export const OUTBOX_EVENT_TYPE = {
  REFUND_PATIENT_NOTICE: 'refund.patient_notice',
  REFUND_DOCTOR_NOTICE: 'refund.doctor_notice',
} as const;

export const OUTBOX_STATUS = {
  PENDING: 'pending',
  PROCESSING: 'processing',
  DONE: 'done',
  // Gave up after maxAttempts. A critical ReconciliationFinding is raised for a human.
  FAILED: 'failed',
} as const;

export type TOutboxEventType = (typeof OUTBOX_EVENT_TYPE)[keyof typeof OUTBOX_EVENT_TYPE];
export type TOutboxStatus = (typeof OUTBOX_STATUS)[keyof typeof OUTBOX_STATUS];

export interface TOutboxEvent {
  type: TOutboxEventType;
  dedupeKey: string;
  payload: Record<string, unknown>;
  status: TOutboxStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lockedUntil: Date | null;
  processedAt: Date | null;
  lastError: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export type OutboxEventModel = Model<TOutboxEvent>;

const outboxSchema = new Schema<TOutboxEvent, OutboxEventModel>(
  {
    type: { type: String, enum: Object.values(OUTBOX_EVENT_TYPE), required: true },
    dedupeKey: { type: String, required: true, unique: true, trim: true },
    payload: { type: Schema.Types.Mixed, required: true },
    status: { type: String, enum: Object.values(OUTBOX_STATUS), default: OUTBOX_STATUS.PENDING, required: true },
    attempts: { type: Number, default: 0, min: 0 },
    maxAttempts: { type: Number, default: 8, min: 1 },
    nextAttemptAt: { type: Date, default: Date.now, required: true },
    lockedUntil: { type: Date, default: null },
    processedAt: { type: Date, default: null },
    lastError: { type: String, default: null },
  },
  { timestamps: true, strict: true },
);

// What the drain job scans.
outboxSchema.index({ status: 1, nextAttemptAt: 1 });
// Delivered events are operational data, not financial records: keep 30 days for support.
outboxSchema.index(
  { processedAt: 1 },
  { expireAfterSeconds: 30 * 24 * 3600, partialFilterExpression: { status: OUTBOX_STATUS.DONE } },
);

export const OutboxEvent = model<TOutboxEvent, OutboxEventModel>('OutboxEvent', outboxSchema);
