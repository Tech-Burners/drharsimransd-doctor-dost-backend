// Agora access behind an interface so tests never touch the network.
//
//  - mintRtcToken: an RTC token scoped to ONE channel and ONE uid, expiring just past the call's
//    affordable duration (the first of three cut-off layers).
//  - closeChannel: removes both uids from the channel via Agora's "Banning user privileges"
//    REST API (the in-process timer and the overdue-call sweep use it).
//  - verifyAgoraSignature: webhook signature on the RAW body.
//
// NOT VERIFIED against real Agora (no credentials): the token being accepted by the client SDK,
// the exact kicking-rule endpoint/body (the docs page used for the webhook did not describe
// it), and the encoding of the V2 signature (hex is documented only for the SHA1 sample).
import { createHmac, timingSafeEqual } from 'crypto';
import httpStatus from 'http-status';
import { RtcRole, RtcTokenBuilder } from 'agora-token';
import config from '../app/config';
import AppError from '../app/error/AppError';
import { logger } from './logger';

export interface AgoraClient {
  mintRtcToken(input: { channelName: string; uid: number; ttlSeconds: number }): string;
  closeChannel(input: { channelName: string; uids: number[]; banSeconds: number }): Promise<void>;
}

const KICK_URL = 'https://api.agora.io/dev/v1/kicking-rule';
const TIMEOUT_MS = 8000;

export class RealAgoraClient implements AgoraClient {
  mintRtcToken({ channelName, uid, ttlSeconds }: { channelName: string; uid: number; ttlSeconds: number }): string {
    const { appId, appCertificate } = config.agora;
    if (!appId || !appCertificate) {
      throw new AppError(httpStatus.SERVICE_UNAVAILABLE, 'Calling is not configured');
    }
    const ttl = Math.max(60, Math.ceil(ttlSeconds));
    // Relative lifetimes in seconds; PUBLISHER because both parties speak.
    return RtcTokenBuilder.buildTokenWithUid(appId, appCertificate, channelName, uid, RtcRole.PUBLISHER, ttl, ttl);
  }

  async closeChannel({ channelName, uids, banSeconds }: { channelName: string; uids: number[]; banSeconds: number }): Promise<void> {
    const { appId, customerId, customerSecret } = config.agora;
    if (!appId || !customerId || !customerSecret) {
      throw new Error('Agora REST credentials are not configured');
    }
    const auth = `Basic ${Buffer.from(`${customerId}:${customerSecret}`).toString('base64')}`;
    for (const uid of uids) {
      const res = await fetch(KICK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ appid: appId, cname: channelName, uid, time_in_seconds: banSeconds, privileges: ['join_channel'] }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Agora kicking-rule responded ${res.status}`);
    }
  }
}

let client: AgoraClient | null = null;
export const getAgoraClient = (): AgoraClient => (client ??= new RealAgoraClient());
/** Tests inject a client. Pass null to restore the real one. */
export const setAgoraClient = (c: AgoraClient | null): void => {
  client = c;
};

const safeEqualHex = (expectedHex: string, given: string): boolean => {
  const a = Buffer.from(expectedHex, 'utf8');
  const b = Buffer.from(given.trim().toLowerCase(), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Verify the webhook on the exact bytes received. Fails closed: no secret, no body or no
 * signature header means "not verified".
 *  - `Agora-Signature-V2` (HMAC-SHA256) is preferred; when it is present it MUST match, there is
 *    no falling back to the weaker header.
 *  - Otherwise `Agora-Signature` (HMAC-SHA1) must match.
 * Digests are compared as lowercase hex.
 */
export const verifyAgoraSignature = (
  rawBody: unknown,
  headers: { v1?: string; v2?: string },
  secret: string | undefined,
): boolean => {
  if (!secret || !Buffer.isBuffer(rawBody)) return false;
  if (headers.v2) return safeEqualHex(createHmac('sha256', secret).update(rawBody).digest('hex'), headers.v2);
  if (headers.v1) return safeEqualHex(createHmac('sha1', secret).update(rawBody).digest('hex'), headers.v1);
  return false;
};

/** Best effort: closing a channel must never throw into a caller that is mid-flow. */
export const tryCloseChannel = async (input: { channelName: string; uids: number[]; banSeconds?: number }): Promise<boolean> => {
  try {
    await getAgoraClient().closeChannel({ ...input, banSeconds: input.banSeconds ?? 60 });
    return true;
  } catch (err) {
    logger.error({ err, channelName: input.channelName }, 'could not close the Agora channel');
    return false;
  }
};
