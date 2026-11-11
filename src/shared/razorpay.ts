// Razorpay access behind a small interface so tests (and a future provider swap) never
// touch the network. Orders are created with Razorpay's REST API directly; webhook
// signatures are verified here on the RAW request bytes.
//
// NOT verified against the real Razorpay API: no credentials were available. See
// PROGRESS.md for the manual checks.
import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import httpStatus from 'http-status';
import config from '../app/config';
import AppError from '../app/error/AppError';
import { logger } from './logger';

export interface GatewayOrder {
  id: string;
  amountPaise: number;
  currency: string;
}

export interface PaymentGateway {
  createOrder(input: { amountPaise: number; notes: Record<string, string> }): Promise<GatewayOrder>;
}

const ORDERS_URL = 'https://api.razorpay.com/v1/orders';
const TIMEOUT_MS = 10000;

export class RazorpayGateway implements PaymentGateway {
  async createOrder(input: { amountPaise: number; notes: Record<string, string> }): Promise<GatewayOrder> {
    const { keyId, keySecret } = config.razorpay;
    if (!keyId || !keySecret) {
      throw new AppError(httpStatus.SERVICE_UNAVAILABLE, 'Payments are not configured');
    }
    let res: Response;
    try {
      res = await fetch(ORDERS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
        },
        body: JSON.stringify({
          amount: input.amountPaise,
          currency: 'INR',
          receipt: `ord_${randomUUID().replace(/-/g, '').slice(0, 30)}`,
          notes: input.notes,
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      logger.error({ err }, 'razorpay order request failed');
      throw new AppError(httpStatus.BAD_GATEWAY, 'Could not reach the payment provider. Please try again.');
    }
    const json = (await res.json().catch(() => null)) as { id?: string; amount?: number; currency?: string } | null;
    if (!res.ok || !json || typeof json.id !== 'string') {
      logger.error({ status: res.status }, 'razorpay rejected the order');
      throw new AppError(httpStatus.BAD_GATEWAY, 'The payment provider could not create the order.');
    }
    if (json.amount !== input.amountPaise || json.currency !== 'INR') {
      logger.error({ orderId: json.id }, 'razorpay order amount or currency differs from the request');
      throw new AppError(httpStatus.BAD_GATEWAY, 'The payment provider returned an unexpected order.');
    }
    return { id: json.id, amountPaise: json.amount, currency: json.currency };
  }
}

let gateway: PaymentGateway | null = null;
export const getPaymentGateway = (): PaymentGateway => (gateway ??= new RazorpayGateway());
/** Tests inject a gateway. Pass null to restore the real one. */
export const setPaymentGateway = (g: PaymentGateway | null): void => {
  gateway = g;
};

/**
 * HMAC-SHA256 of the exact bytes received, hex, compared in constant time. Fails closed:
 * a missing secret, header or non-Buffer body is "not verified".
 */
export const verifyWebhookSignature = (
  rawBody: unknown,
  signature: string | undefined,
  secret: string | undefined,
): boolean => {
  if (!secret || !signature || !Buffer.isBuffer(rawBody)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature.trim(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};
