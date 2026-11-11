import { Request, Response } from 'express';
import httpStatus from 'http-status';
import config from '../../config';
import AppError from '../../error/AppError';
import catchAsync from '../../utils/catchAsync';
import sendResponse from '../../utils/sendResponse';
import { logger } from '../../../shared/logger';
import { verifyWebhookSignature } from '../../../shared/razorpay';
import { paymentService } from './payment.service';

/**
 * req.body is the exact Buffer Razorpay sent (webhook.route.ts mounts express.raw before
 * the JSON parser). The signature is checked on those bytes BEFORE anything is parsed.
 * Unverified payloads are logged (without the body) and dropped.
 */
export const razorpayWebhook = catchAsync(async (req: Request, res: Response) => {
  const signature = req.get('x-razorpay-signature');
  if (!verifyWebhookSignature(req.body, signature, config.razorpay.webhookSecret)) {
    logger.warn(
      {
        hasSignature: !!signature,
        bytes: Buffer.isBuffer(req.body) ? req.body.length : null,
        secretConfigured: !!config.razorpay.webhookSecret,
      },
      'razorpay webhook rejected: signature not verified',
    );
    throw new AppError(httpStatus.BAD_REQUEST, 'Invalid webhook signature');
  }

  let event: unknown;
  try {
    event = JSON.parse((req.body as Buffer).toString('utf8'));
  } catch {
    throw new AppError(httpStatus.BAD_REQUEST, 'Malformed webhook body');
  }

  // Any thrown error is a 5xx so Razorpay retries; "already processed" is a normal 200.
  const outcome = await paymentService.creditFromWebhook(event);
  sendResponse(res, { statusCode: httpStatus.OK, success: true, message: 'Webhook processed', data: { outcome } });
});
