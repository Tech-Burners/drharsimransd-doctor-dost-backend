import { ClientSession } from 'mongoose';
import { logger } from '../../../shared/logger';
import { ReconciliationFinding } from '../reconciliationFinding/reconciliationFinding.model';
import { OUTBOX_STATUS, OutboxEvent, TOutboxEvent, TOutboxEventType } from './outbox.model';

export interface NewOutboxEvent {
  type: TOutboxEventType;
  /** Unique. A retried or re-run transaction cannot queue the same notice twice. */
  dedupeKey: string;
  payload: Record<string, unknown>;
}

/** Queue events INSIDE the caller's transaction, so they commit or abort with the money. */
const addEvents = async (session: ClientSession, events: NewOutboxEvent[]) => {
  if (events.length === 0) return;
  await OutboxEvent.create(events, { session, ordered: true });
};

export type OutboxHandler = (event: TOutboxEvent & { _id: unknown }) => Promise<void>;
export type OutboxHandlers = Partial<Record<TOutboxEventType, OutboxHandler>>;

const LOCK_MS = 60_000;
const backoffMs = (attempts: number) => Math.min(30_000 * 2 ** (attempts - 1), 60 * 60_000);

/**
 * Deliver due events, at most `limit` per call. Safe to run from several workers at once:
 * an event is claimed with one atomic update, and a claim whose worker died (lockedUntil in
 * the past) is picked up again. Delivery is at-least-once, so handlers must be idempotent on
 * the event id.
 */
const drain = async (handlers: OutboxHandlers, opts: { limit?: number; now?: Date } = {}) => {
  const limit = opts.limit ?? 20;
  const stats = { delivered: 0, retried: 0, failed: 0 };

  for (let i = 0; i < limit; i += 1) {
    const now = opts.now ?? new Date();
    const event = await OutboxEvent.findOneAndUpdate(
      {
        $or: [
          { status: OUTBOX_STATUS.PENDING, nextAttemptAt: { $lte: now } },
          { status: OUTBOX_STATUS.PROCESSING, lockedUntil: { $lt: now } },
        ],
      },
      { $set: { status: OUTBOX_STATUS.PROCESSING, lockedUntil: new Date(now.getTime() + LOCK_MS) }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, new: true },
    );
    if (!event) break;

    try {
      const handler = handlers[event.type];
      if (!handler) throw new Error(`no handler for outbox event type ${event.type}`);
      await handler(event as unknown as TOutboxEvent & { _id: unknown });
      await OutboxEvent.updateOne(
        { _id: event._id },
        { $set: { status: OUTBOX_STATUS.DONE, processedAt: new Date(), lockedUntil: null, lastError: null } },
      );
      stats.delivered += 1;
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500);
      if (event.attempts >= event.maxAttempts) {
        await OutboxEvent.updateOne(
          { _id: event._id },
          { $set: { status: OUTBOX_STATUS.FAILED, lockedUntil: null, lastError: message } },
        );
        await ReconciliationFinding.create({
          runAt: new Date(),
          checkName: 'outbox_event_failed',
          severity: 'critical',
          entityType: 'OutboxEvent',
          entityId: event._id,
          detail: { type: event.type, dedupeKey: event.dedupeKey, attempts: event.attempts, lastError: message },
        });
        logger.error({ eventId: String(event._id), type: event.type }, 'outbox event gave up');
        stats.failed += 1;
      } else {
        await OutboxEvent.updateOne(
          { _id: event._id },
          {
            $set: {
              status: OUTBOX_STATUS.PENDING,
              lockedUntil: null,
              lastError: message,
              nextAttemptAt: new Date(now.getTime() + backoffMs(event.attempts)),
            },
          },
        );
        stats.retried += 1;
      }
    }
  }
  return stats;
};

export const outboxService = { addEvents, drain };
