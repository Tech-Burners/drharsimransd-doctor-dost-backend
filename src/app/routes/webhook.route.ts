import express, { Router } from 'express';
import { razorpayWebhook } from '../modules/payment/razorpayWebhook.controller';
import { agoraCallWebhook } from '../modules/agoraCallEvent/agoraWebhook.controller';
import { registerRoute } from '../../shared/openapi';

/**
 * Webhook routes. app.ts mounts this router BEFORE express.json(), behind express.raw(),
 * so req.body is the exact Buffer the provider sent. Signature verification (Razorpay in
 * Phase 5, Agora in Phase 6) must run on those bytes; parsing and re-serialising JSON
 * changes them and breaks the signature.
 *
 * Each phase adds its own handler here.
 */
export const webhookRouter = Router();

webhookRouter.post('/razorpay', razorpayWebhook);
webhookRouter.post('/agora/call', agoraCallWebhook);

// Cap the raw body; webhook payloads are small.
export const rawBodyParser = express.raw({ type: '*/*', limit: '1mb' });

registerRoute({
  method: 'post',
  path: '/webhooks/razorpay',
  tags: ['webhooks'],
  summary:
    'Razorpay events. X-Razorpay-Signature is verified on the raw body. The ONLY path that credits a wallet',
  responses: {
    200: { description: 'Processed, or already processed' },
    400: { description: 'Signature not verified, or malformed body' },
  },
});

registerRoute({
  method: 'post',
  path: '/webhooks/agora/call',
  tags: ['webhooks'],
  summary:
    'Agora channel events. Agora-Signature-V2 (HMAC-SHA256) or Agora-Signature (HMAC-SHA1) is verified on the raw body. Events are stored first (duplicates are a no-op); the call duration is DERIVED from them',
  responses: {
    200: { description: 'Stored, duplicate, or ignored (JSON body, as Agora requires)' },
    401: { description: 'Signature not verified' },
  },
});
