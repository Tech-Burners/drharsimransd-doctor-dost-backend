import { Model, Types } from 'mongoose';

export interface TAgoraCallEvent {
  callId: Types.ObjectId;
  channelName: string;
  uid: string;
  eventType: string;
  eventTs: Date;
  providerEventId: string;
  raw: unknown;
  receivedAt: Date;
}

export type AgoraCallEventModel = Model<TAgoraCallEvent>;
