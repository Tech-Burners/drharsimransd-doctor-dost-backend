// Append-only audit ledger for everything that changes what a doctor is owed AFTER an
// earning exists: a refund reversing it, the recovery that creates, the recovery being
// taken back from a later withdrawal, and an admin write-off.
//
// A doctor has no wallet balance (WalletLedger is the patient wallet; every row needs a
// walletId and a balance that cannot go negative), so this is the doctor-side counterpart.
// Each row points at the original DoctorEarning and, for a refund, at the patient's refund
// WalletLedger entry. The earning itself is never deleted or overwritten in meaning: its
// totals (recoveryPaise / recoveredPaise / writtenOffPaise) can always be re-derived by
// summing these rows. No soft delete, no update path, no delete path.
import { model, Schema, Model, Types } from 'mongoose';

export const DOCTOR_ADJUSTMENT_TYPE = {
  // The earning stopped being payable because its call was refunded. amountPaise = netPaise.
  EARNING_REVERSAL: 'earning_reversal',
  // Part of the reversed earning had already been paid out; the doctor owes it back.
  RECOVERY_RECORDED: 'recovery_recorded',
  // Part of that debt was taken from a later withdrawal.
  RECOVERY_SETTLED: 'recovery_settled',
  // An admin forgave what was still outstanding, after the recovery period.
  RECOVERY_WRITE_OFF: 'recovery_write_off',
} as const;

export type TDoctorAdjustmentType =
  (typeof DOCTOR_ADJUSTMENT_TYPE)[keyof typeof DOCTOR_ADJUSTMENT_TYPE];

export interface TDoctorLedgerAdjustment {
  doctorId: Types.ObjectId;
  earningId: Types.ObjectId;
  callId: Types.ObjectId;
  type: TDoctorAdjustmentType;
  amountPaise: number;
  refundLedgerEntryId: Types.ObjectId | null;
  withdrawalRequestId: Types.ObjectId | null;
  idempotencyKey: string;
  createdBy: Types.ObjectId | null; // null = the system (a refund, a withdrawal)
  note: string;
  metadata: Record<string, unknown>;
  createdAt?: Date;
}

export type DoctorLedgerAdjustmentModel = Model<TDoctorLedgerAdjustment>;

const schema = new Schema<TDoctorLedgerAdjustment, DoctorLedgerAdjustmentModel>(
  {
    doctorId: { type: Schema.Types.ObjectId, ref: 'Doctor', required: true },
    earningId: { type: Schema.Types.ObjectId, ref: 'DoctorEarning', required: true },
    callId: { type: Schema.Types.ObjectId, ref: 'Call', required: true },
    type: { type: String, enum: Object.values(DOCTOR_ADJUSTMENT_TYPE), required: true },
    amountPaise: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isSafeInteger, message: 'Amount must be a safe integer in paise' },
    },
    refundLedgerEntryId: { type: Schema.Types.ObjectId, ref: 'WalletLedger', default: null },
    withdrawalRequestId: { type: Schema.Types.ObjectId, ref: 'WithdrawalRequest', default: null },
    // Deterministic per event, e.g. `earning:<id>:reversal`. A duplicate is an E11000.
    idempotencyKey: { type: String, required: true, unique: true, trim: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, default: '' },
    metadata: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: { createdAt: true, updatedAt: false }, strict: true },
);

schema.index({ doctorId: 1, createdAt: -1 });
schema.index({ earningId: 1, createdAt: 1 });
schema.index({ callId: 1 });

const blockOp = (op: string) =>
  function (next: (err?: Error) => void) {
    next(new Error(`DoctorLedgerAdjustment is append-only: ${op} is not allowed`));
  };
schema.pre(['updateOne', 'updateMany', 'findOneAndUpdate', 'findOneAndReplace', 'replaceOne'], blockOp('update'));
schema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], blockOp('delete'));
schema.pre('save', function (next) {
  if (!this.isNew) return next(new Error('DoctorLedgerAdjustment is append-only'));
  next();
});

export const DoctorLedgerAdjustment = model<TDoctorLedgerAdjustment, DoctorLedgerAdjustmentModel>(
  'DoctorLedgerAdjustment',
  schema,
);
