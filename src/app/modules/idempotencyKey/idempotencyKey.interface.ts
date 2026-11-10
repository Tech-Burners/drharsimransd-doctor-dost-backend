import { Model, Types } from 'mongoose';

export interface TIdempotencyKey {
  key: string;
  userId: Types.ObjectId;
  endpoint: string;
  requestHash: string;
  responseBody?: unknown;
  statusCode?: number;
  createdAt: Date;
}

export type IdempotencyKeyModel = Model<TIdempotencyKey>;
