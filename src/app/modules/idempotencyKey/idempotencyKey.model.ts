// A retried money POST returns the stored response instead of creating a second
// order, withdrawal or call. Expires after 24h. No soft delete.
import { model, Schema } from 'mongoose';
import {
  TIdempotencyKey,
  IdempotencyKeyModel,
} from './idempotencyKey.interface';

const idempotencyKeySchema = new Schema<TIdempotencyKey, IdempotencyKeyModel>(
  {
    key: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    endpoint: { type: String, required: true },
    requestHash: { type: String, required: true },
    responseBody: { type: Schema.Types.Mixed },
    statusCode: { type: Number },
    createdAt: { type: Date, default: Date.now },
  },
  { strict: true },
);

idempotencyKeySchema.index({ key: 1, userId: 1 }, { unique: true });
idempotencyKeySchema.index({ createdAt: 1 }, { expireAfterSeconds: 86400 });

export const IdempotencyKey = model<TIdempotencyKey, IdempotencyKeyModel>(
  'IdempotencyKey',
  idempotencyKeySchema,
);
