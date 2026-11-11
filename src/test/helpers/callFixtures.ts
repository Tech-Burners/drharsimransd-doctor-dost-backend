// Shared fixtures for the call suites. Everything external is a test double: Agora, FCM, the job
// queues and the real-time emitter. The database is the real replica set (useTestDb) and the
// rate-limit store is a FakeRedis with a controllable clock.
import mongoose from 'mongoose';
import config from '../../app/config';
import { AgoraClient, setAgoraClient } from '../../shared/agora';
import { PushSender, setPushSender } from '../../shared/fcm';
import { RealtimeEmitter, setRealtimeEmitter } from '../../shared/realtime';
import { setRateLimitStore } from '../../shared/rateLimit';
import { CallJobs, setCallJobs } from '../../app/modules/call/call.jobs';
import { FakeRedis } from './fakeRedis';
import { User } from '../../app/modules/user/user.model';
import { Doctor } from '../../app/modules/doctor/doctor.model';
import { PlatformSetting } from '../../app/modules/platformSetting/platformSetting.model';
import { AgoraCallEvent } from '../../app/modules/agoraCallEvent/agoraCallEvent.model';
import { presenceService } from '../../app/modules/presence/presence.service';
import { walletService } from '../../app/modules/wallet/wallet.service';
import { runInTransaction } from '../../shared/transaction';
import { issueTokenPair } from '../../app/modules/auth/auth.tokens';
import { WALLET_LEDGER_DIRECTION as DIR, WALLET_LEDGER_TYPE as TYPE } from '../../app/modules/wallet/walletLedger.constants';

export class FakeAgora implements AgoraClient {
  minted: Array<{ channelName: string; uid: number; ttlSeconds: number }> = [];
  closed: Array<{ channelName: string; uids: number[] }> = [];
  failMint = false;
  failClose = false;
  mintRtcToken(input: { channelName: string; uid: number; ttlSeconds: number }) {
    if (this.failMint) throw new Error('agora down');
    this.minted.push(input);
    return `token:${input.channelName}:${input.uid}`;
  }
  async closeChannel(input: { channelName: string; uids: number[]; banSeconds: number }) {
    if (this.failClose) throw new Error('agora rest down');
    this.closed.push({ channelName: input.channelName, uids: input.uids });
  }
}

export class FakePush implements PushSender {
  sent: Array<{ tokens: string[]; data: Record<string, string> }> = [];
  async sendData(tokens: string[], data: Record<string, string>) {
    this.sent.push({ tokens, data });
    return tokens.length;
  }
}

export class FakeJobs implements CallJobs {
  ringing: string[] = [];
  finalize: Array<{ callId: string; key: string }> = [];
  prescription: Array<{ callId: string; reminderDelayMs: number; expiryDelayMs: number }> = [];
  fail = false;
  async scheduleRingingTimeout(callId: string) {
    if (this.fail) throw new Error('redis down');
    this.ringing.push(callId);
  }
  async scheduleFinalize(callId: string, key: string) {
    if (this.fail) throw new Error('redis down');
    this.finalize.push({ callId, key });
  }
  async schedulePrescriptionJobs(callId: string, reminderDelayMs: number, expiryDelayMs: number) {
    if (this.fail) throw new Error('redis down');
    this.prescription.push({ callId, reminderDelayMs, expiryDelayMs });
  }
}

export class FakeRealtime implements RealtimeEmitter {
  events: Array<{ userId: string; event: string; payload: unknown }> = [];
  emitToUser(userId: string, event: string, payload: unknown) {
    this.events.push({ userId, event, payload });
  }
  to(userId: string, event: string) {
    return this.events.filter((e) => e.userId === userId && e.event === event);
  }
}

export interface Doubles {
  redis: FakeRedis;
  agora: FakeAgora;
  push: FakePush;
  jobs: FakeJobs;
  realtime: FakeRealtime;
}

/** Install fresh doubles. Call in beforeEach. */
export const installDoubles = (): Doubles => {
  const d: Doubles = { redis: new FakeRedis(), agora: new FakeAgora(), push: new FakePush(), jobs: new FakeJobs(), realtime: new FakeRealtime() };
  setRateLimitStore(d.redis);
  setAgoraClient(d.agora);
  setPushSender(d.push);
  setCallJobs(d.jobs);
  setRealtimeEmitter(d.realtime);
  config.agora.appId = 'test-app-id';
  config.agora.webhookSecret = 'agora-test-secret';
  config.agora.tokenGraceSeconds = 60;
  return d;
};

export const removeDoubles = () => {
  setRateLimitStore(null);
  setAgoraClient(null);
  setPushSender(null);
  setCallJobs(null);
  setRealtimeEmitter(null);
};

let seq = 0;
const PASSWORD = 'Str0ng-Passw0rd';

/** The singleton settings document; a second call in one test reuses it. */
export const makeSettings = async (overrides: Record<string, unknown> = {}) =>
  (await PlatformSetting.findOne()) ?? PlatformSetting.create(overrides);

export const topup = (userId: unknown, amountPaise: number) =>
  runInTransaction((s) =>
    walletService.append(s, { userId: userId as never, type: TYPE.TOPUP, direction: DIR.CREDIT, amountPaise, idempotencyKey: `fx-topup-${userId}-${amountPaise}-${Math.random()}` }),
  );

export const makePatient = async (balancePaise = 100000) => {
  seq += 1;
  const user = await User.create({ name: `Patient${seq}`, email: `patient${seq}@example.com`, password: PASSWORD, role: 'patient', emailVerified: true });
  if (balancePaise > 0) await topup(user._id, balancePaise);
  const { accessToken } = await issueTokenPair(user);
  return { user, auth: { Authorization: `Bearer ${accessToken}` } };
};

export const makeDoctor = async (opts: { online?: boolean; phoneVerified?: boolean; approved?: boolean; day?: number | null; night?: number | null; commissionPercent?: number | null; payoutMode?: string } = {}) => {
  seq += 1;
  const user = await User.create({
    name: `Doctor${seq}`, email: `doctor${seq}@example.com`, password: PASSWORD, role: 'doctor', emailVerified: true,
    phone: `+9198${String(70000000 + seq)}`, phoneVerified: opts.phoneVerified ?? true,
  });
  const doctor = await Doctor.create({
    userId: user._id,
    approvalStatus: opts.approved === false ? 'pending' : 'approved',
    consultationRateDayPaise: opts.day === undefined ? 1500 : opts.day,
    consultationRateNightPaise: opts.night === undefined ? 2500 : opts.night,
    commissionPercent: opts.commissionPercent === undefined ? null : opts.commissionPercent,
    ...(opts.payoutMode ? { payoutMode: opts.payoutMode } : {}),
  });
  if (opts.online !== false) await presenceService.heartbeat(String(doctor._id));
  const { accessToken } = await issueTokenPair(user);
  return { user, doctor, auth: { Authorization: `Bearer ${accessToken}` } };
};

/** 12:00 IST, inside the default day window. */
export const NOON_IST = new Date('2026-03-10T06:30:00Z');

/** Insert Agora join/leave events (communication mode 107/108) for a call. */
export const addEvent = async (
  call: { _id: unknown; agoraChannelName: string; agoraUidPatient: string; agoraUidDoctor: string },
  who: 'patient' | 'doctor',
  kind: 'join' | 'leave',
  atSeconds: number,
  clientSeq?: number,
  base = Date.UTC(2026, 2, 10, 6, 30, 0),
) => {
  const uid = who === 'patient' ? call.agoraUidPatient : call.agoraUidDoctor;
  const eventType = kind === 'join' ? '107' : '108';
  const seq2 = clientSeq ?? atSeconds * 1000 + (kind === 'join' ? 0 : 1);
  return AgoraCallEvent.create({
    callId: call._id,
    channelName: call.agoraChannelName,
    uid,
    eventType,
    eventTs: new Date(base + atSeconds * 1000),
    providerEventId: `${call.agoraChannelName}:${uid}:${eventType}:${seq2}`,
    raw: { noticeId: `n-${Math.random()}`, productId: 1, eventType: Number(eventType), payload: { channelName: call.agoraChannelName, uid: Number(uid), ts: Math.floor((base + atSeconds * 1000) / 1000), clientSeq: seq2 } },
  });
};

/** Both parties talk for exactly `seconds` (the patient joins first, the doctor 1 s later). */
export const talk = async (
  call: { _id: unknown; agoraChannelName: string; agoraUidPatient: string; agoraUidDoctor: string },
  seconds: number,
  leaver: 'patient' | 'doctor' = 'patient',
) => {
  await addEvent(call, 'patient', 'join', 0);
  await addEvent(call, 'doctor', 'join', 1);
  const end = 1 + seconds;
  await addEvent(call, leaver, 'leave', end);
  await addEvent(call, leaver === 'patient' ? 'doctor' : 'patient', 'leave', end + 1);
};

export const oid = () => new mongoose.Types.ObjectId();
