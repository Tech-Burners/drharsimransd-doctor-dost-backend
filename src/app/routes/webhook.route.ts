import express, { Router } from 'express';

/**
 * Webhook routes. app.ts mounts this router BEFORE express.json(), behind express.raw(),
 * so req.body is the exact Buffer the provider sent. Signature verification (Razorpay in
 * Phase 5, Agora in Phase 6) must run on those bytes; parsing and re-serialising JSON
 * changes them and breaks the signature.
 *
 * No webhook handlers exist yet. Each phase adds its own here.
 */
export const webhookRouter = Router();

// Cap the raw body; webhook payloads are small.
export const rawBodyParser = express.raw({ type: '*/*', limit: '1mb' });
