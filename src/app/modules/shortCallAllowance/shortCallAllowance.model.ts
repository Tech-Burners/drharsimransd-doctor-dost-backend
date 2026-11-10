// A document exists only while the free short-call allowance is spent. The TTL index
// on consumedAt IS the 24h window, so granting is a single insert that either succeeds
// or throws E11000. The TTL monitor runs every 60s, so expiry can lag a minute.
// No soft delete: do not apply softDeletePlugin.
import { model, Schema } from 'mongoose';
import {
  TShortCallAllowance,
  ShortCallAllowanceModel,
} from './shortCallAllowance.interface';

const shortCallAllowanceSchema = new Schema<
  TShortCallAllowance,
  ShortCallAllowanceModel
>(
  {
    patientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    callId: { type: Schema.Types.ObjectId, ref: 'Call', required: true },
    consumedAt: { type: Date, default: Date.now },
  },
  { strict: true },
);

shortCallAllowanceSchema.index({ patientId: 1, doctorId: 1 }, { unique: true });
shortCallAllowanceSchema.index({ consumedAt: 1 }, { expireAfterSeconds: 86400 });

export const ShortCallAllowance = model<
  TShortCallAllowance,
  ShortCallAllowanceModel
>('ShortCallAllowance', shortCallAllowanceSchema);
