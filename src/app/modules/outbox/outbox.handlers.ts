// Delivery of outbox events. Runs in the WORKER process, outside any transaction.
//
// Channels today: the in-app Notification row (respecting the user's per-type setting).
// Real-time socket pushes live in the API process and push (FCM) / email are not built yet;
// when they are, they are added here and the refund transaction does not change.
import { Types } from 'mongoose';
import { Notification } from '../notification/notification.model';
import { NOTIFICATION_TYPE } from '../notification/notification.constants';
import { NotificationSetting } from '../notificationSetting/notificationSetting.model';
import { OUTBOX_EVENT_TYPE } from './outbox.model';
import { OutboxHandlers } from './outbox.service';

/** Display only: integer paise to "₹1,234.50". Money is never stored or computed this way. */
export const formatRupees = (paise: number): string =>
  `₹${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

const deliverInApp = async (input: {
  eventId: unknown;
  userId: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
}) => {
  const eventId = String(input.eventId);
  // Idempotent: at-least-once delivery must not create two notifications.
  if (await Notification.exists({ userId: input.userId, 'data.outboxEventId': eventId })) return;

  const prefs = await NotificationSetting.findOne({ userId: input.userId }).lean();
  if (prefs && (prefs as Record<string, unknown>)[NOTIFICATION_TYPE.PAYMENT] === false) return;

  await Notification.create({
    userId: new Types.ObjectId(input.userId),
    type: NOTIFICATION_TYPE.PAYMENT,
    title: input.title,
    body: input.body,
    data: { ...input.data, outboxEventId: eventId },
  });
};

export const outboxHandlers: OutboxHandlers = {
  [OUTBOX_EVENT_TYPE.REFUND_PATIENT_NOTICE]: async (event) => {
    const p = event.payload as {
      userId: string; callId: string; amountPaise: number; status: string; reference: string; refundEntryId: string;
    };
    await deliverInApp({
      eventId: event._id,
      userId: p.userId,
      title: 'Refund processed',
      body: `${formatRupees(p.amountPaise)} has been refunded to your wallet for a call. Status: ${p.status}.`,
      data: {
        kind: 'refund', callId: p.callId, amountPaise: p.amountPaise, status: p.status,
        reference: p.reference, refundEntryId: p.refundEntryId,
      },
    });
  },

  [OUTBOX_EVENT_TYPE.REFUND_DOCTOR_NOTICE]: async (event) => {
    const p = event.payload as {
      userId: string; callId: string; earningId: string | null; action: string;
      earningNetPaise: number; reversedPaise: number; recoveredNowPaise: number;
      newRecoveryPaise: number; totalOutstandingRecoveryPaise: number;
    };
    const lines = [
      p.action === 'forfeited'
        ? `A refunded call's earning of ${formatRupees(p.earningNetPaise)} was cancelled before it was released.`
        : p.reversedPaise > 0
          ? `A call was refunded and ${formatRupees(p.reversedPaise)} of your earning was reversed.`
          : 'A call was refunded. No earning was affected.',
    ];
    if (p.recoveredNowPaise > 0) lines.push(`${formatRupees(p.recoveredNowPaise)} was taken from unpaid earnings.`);
    if (p.newRecoveryPaise > 0) lines.push(`${formatRupees(p.newRecoveryPaise)} was already paid out and will be recovered from your future withdrawals.`);
    if (p.totalOutstandingRecoveryPaise > 0) lines.push(`Total outstanding recovery: ${formatRupees(p.totalOutstandingRecoveryPaise)}.`);
    await deliverInApp({
      eventId: event._id,
      userId: p.userId,
      title: 'A call was refunded',
      body: lines.join(' '),
      data: { kind: 'refund_earning', ...p },
    });
  },
};
