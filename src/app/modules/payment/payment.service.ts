// Wallet top-ups. The ONLY path that credits a wallet from a payment is the verified
// Razorpay webhook (creditFromWebhook). Neither the order endpoint nor anything the app
// reports after checkout moves money.
import httpStatus from 'http-status';
import config from '../../config';
import AppError from '../../error/AppError';
import { logger } from '../../../shared/logger';
import { getPaymentGateway } from '../../../shared/razorpay';
import { runInTransaction } from '../../../shared/transaction';
import { walletService } from '../wallet/wallet.service';
import { WALLET_LEDGER_DIRECTION, WALLET_LEDGER_TYPE } from '../wallet/walletLedger.constants';
import { PaymentOrder } from './paymentOrder.model';
import { PAYMENT_ORDER_STATUS } from './paymentOrder.constants';
import { ReconciliationFinding } from '../reconciliationFinding/reconciliationFinding.model';
import { enforce } from '../../../shared/rateLimit';
import { ORDER_LIMITS } from './payment.constants';
import { PlatformSetting } from '../platformSetting/platformSetting.model';
import {
  PAISE_PER_RUPEE,
  TOPUP_DEFAULT_MAX_PAISE,
  TOPUP_DEFAULT_MIN_PAISE,
} from '../platformSetting/platformSetting.constants';

export interface TopupLimits {
  minPaise: number;
  maxPaise: number;
}

/**
 * Per-transaction top-up limits from PlatformSetting. Falls back to the schema defaults
 * (Rs 100 / Rs 50,000) when no settings document exists or it predates these fields.
 */
export const getTopupLimits = async (): Promise<TopupLimits> => {
  const s = await PlatformSetting.findOne().select('minTopupPaise maxTopupPaise').lean();
  return {
    minPaise: s?.minTopupPaise ?? TOPUP_DEFAULT_MIN_PAISE,
    maxPaise: s?.maxTopupPaise ?? TOPUP_DEFAULT_MAX_PAISE,
  };
};

const formatRupees = (paise: number) => `Rs ${(paise / PAISE_PER_RUPEE).toLocaleString('en-IN')}`;

/**
 * POST /wallet/orders. The patient chooses the amount, in WHOLE RUPEES (the one client-approved
 * exception to "the body never carries an amount"). It is converted to paise here, at the edge,
 * checked against the server's limits, and stored on the PaymentOrder. The wallet is never
 * credited from this call: only the verified Razorpay webhook credits, for the stored amount.
 */
const createOrder = async (actor: { userId: string }, amountRupees: number, meta: { ip: string } = { ip: '' }) => {
  if (!Number.isSafeInteger(amountRupees) || amountRupees < 1) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Enter a whole number of rupees');
  }
  const amountPaise = amountRupees * PAISE_PER_RUPEE;
  const { minPaise, maxPaise } = await getTopupLimits();
  if (!Number.isSafeInteger(amountPaise) || amountPaise < minPaise || amountPaise > maxPaise) {
    throw new AppError(
      httpStatus.BAD_REQUEST,
      `Top-up must be between ${formatRupees(minPaise)} and ${formatRupees(maxPaise)}`,
    );
  }

  // Abuse limits, BEFORE anything external is touched (see payment.constants.ts).
  const openOrders = await PaymentOrder.countDocuments({
    userId: actor.userId,
    status: PAYMENT_ORDER_STATUS.CREATED,
    createdAt: { $gte: new Date(Date.now() - ORDER_LIMITS.OPEN_ORDERS_WINDOW_MS) },
  });
  if (openOrders >= ORDER_LIMITS.OPEN_ORDERS_PER_DAY) {
    throw new AppError(httpStatus.TOO_MANY_REQUESTS, 'Too many unpaid top-up orders. Complete a payment or try again later.');
  }
  await enforce(`wallet:order:user:${actor.userId}`, ORDER_LIMITS.USER_PER_HOUR, ORDER_LIMITS.WINDOW_SECONDS, 'Too many top-up attempts. Please try again later.');
  if (meta.ip) {
    await enforce(`wallet:order:ip:${meta.ip}`, ORDER_LIMITS.IP_PER_HOUR, ORDER_LIMITS.WINDOW_SECONDS, 'Too many top-up attempts from this network. Please try again later.');
  }

  const wallet = await walletService.ensureWallet(actor.userId);

  // The gateway call is outside any transaction: it is an external service.
  const gatewayOrder = await getPaymentGateway().createOrder({
    amountPaise,
    notes: { userId: actor.userId },
  });

  const order = await PaymentOrder.create({
    userId: actor.userId,
    walletId: wallet._id,
    amountPaise,
    razorpayOrderId: gatewayOrder.id,
    status: PAYMENT_ORDER_STATUS.CREATED,
  });

  return {
    paymentOrderId: String(order._id),
    razorpayOrderId: order.razorpayOrderId,
    amountPaise: order.amountPaise,
    currency: gatewayOrder.currency,
    // Public identifier the checkout SDK needs. The secret never leaves the server.
    razorpayKeyId: config.razorpay.keyId,
  };
};

// Razorpay redelivers a webhook until it gets a 2xx, and anomalies answer 2xx, but a
// retry storm or a second event name for the same payment must not page someone twice:
// one open finding per check and payment.
const finding = async (
  checkName: string,
  severity: 'warning' | 'critical',
  entityId: unknown,
  detail: Record<string, unknown>,
) => {
  const open = await ReconciliationFinding.exists({
    checkName,
    resolvedAt: null,
    ...(typeof detail.paymentId === 'string' && { 'detail.paymentId': detail.paymentId }),
  });
  if (open) return;
  await ReconciliationFinding.create({
    runAt: new Date(),
    checkName,
    severity,
    entityType: 'PaymentOrder',
    entityId: entityId ?? null,
    detail,
  });
};

export type WebhookOutcome = 'credited' | 'duplicate' | 'ignored' | 'rejected';

interface CapturedPayment {
  paymentId: string;
  orderId: string;
  amount: number;
  currency: string;
}

const extractPayment = (event: unknown): CapturedPayment | null => {
  const entity = (event as { payload?: { payment?: { entity?: Record<string, unknown> } } })?.payload?.payment?.entity;
  if (!entity) return null;
  const { id, order_id: orderId, amount, currency } = entity;
  if (typeof id !== 'string' || typeof orderId !== 'string' || typeof amount !== 'number' || typeof currency !== 'string') {
    return null;
  }
  return { paymentId: id, orderId, amount, currency };
};

/**
 * Handle a webhook whose signature has ALREADY been verified on the raw bytes.
 * One transaction commits the ledger credit, the wallet cache and the order (status paid +
 * ledgerEntryId) together. Two simultaneous deliveries of the same payment credit once: the
 * loser either conflicts and re-runs (then sees the order paid) or hits the unique
 * idempotency key; both mean "already processed", answered with 200.
 */
const creditFromWebhook = async (event: unknown): Promise<WebhookOutcome> => {
  const eventName = (event as { event?: string })?.event;
  if (eventName !== 'payment.captured' && eventName !== 'order.paid') return 'ignored';

  const payment = extractPayment(event);
  if (!payment) {
    logger.error({ eventName }, 'razorpay webhook without a usable payment entity');
    return 'rejected';
  }

  const order = await PaymentOrder.findOne({ razorpayOrderId: payment.orderId });
  if (!order) {
    // Money was taken for an order we have no record of. Nothing is credited; a human decides.
    await finding('razorpay_unknown_order', 'critical', null, payment as unknown as Record<string, unknown>);
    logger.error({ orderId: payment.orderId, paymentId: payment.paymentId }, 'webhook for an unknown order');
    return 'rejected';
  }

  // Credit what the SERVER recorded for the order, and only if Razorpay agrees.
  if (payment.amount !== order.amountPaise || payment.currency !== 'INR') {
    await finding('razorpay_amount_mismatch', 'critical', order._id, {
      ...payment,
      expectedPaise: order.amountPaise,
    });
    logger.error({ orderId: payment.orderId }, 'webhook amount or currency does not match the order');
    return 'rejected';
  }

  const idempotencyKey = `razorpay:payment:${payment.paymentId}`;

  try {
    return await runInTransaction<WebhookOutcome>(async (session) => {
      const current = await PaymentOrder.findById(order._id).session(session);
      if (!current) throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Payment order vanished');

      if (current.status === PAYMENT_ORDER_STATUS.PAID) {
        // A different payment id on an already paid order means two payments were taken.
        return current.razorpayPaymentId === payment.paymentId ? 'duplicate' : 'rejected';
      }

      const entry = await walletService.append(session, {
        userId: current.userId,
        type: WALLET_LEDGER_TYPE.TOPUP,
        direction: WALLET_LEDGER_DIRECTION.CREDIT,
        amountPaise: current.amountPaise,
        idempotencyKey,
        referenceType: 'payment_order',
        referenceId: current._id,
        description: 'Wallet top-up',
        metadata: { razorpayPaymentId: payment.paymentId, razorpayOrderId: payment.orderId },
      });

      const updated = await PaymentOrder.updateOne(
        { _id: current._id, status: { $ne: PAYMENT_ORDER_STATUS.PAID } },
        {
          $set: {
            status: PAYMENT_ORDER_STATUS.PAID,
            razorpayPaymentId: payment.paymentId,
            signatureVerified: true,
            paidAt: new Date(),
            ledgerEntryId: entry._id,
          },
        },
        { session },
      );
      if (updated.modifiedCount !== 1) {
        throw new AppError(httpStatus.INTERNAL_SERVER_ERROR, 'Payment order could not be marked paid');
      }
      return 'credited';
    }).then(async (outcome) => {
      if (outcome === 'rejected') {
        await finding('razorpay_second_payment_for_paid_order', 'critical', order._id, payment as unknown as Record<string, unknown>);
      }
      return outcome;
    });
  } catch (err) {
    // The unique ledger idempotencyKey fired: this payment was already credited.
    if ((err as { code?: number }).code === 11000) {
      logger.info({ paymentId: payment.paymentId }, 'duplicate razorpay delivery; already credited');
      return 'duplicate';
    }
    throw err;
  }
};

export const paymentService = { createOrder, creditFromWebhook, getTopupLimits };
