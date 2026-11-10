// Findings written by the nightly reconciliation and the overdue-call sweep.
// Append-only apart from resolvedAt / resolvedBy (and alertedAt, which stops the same
// finding paging someone every night). No soft delete.
import { model, Schema } from 'mongoose';
import {
  TReconciliationFinding,
  ReconciliationFindingModel,
} from './reconciliationFinding.interface';
import { RECONCILIATION_SEVERITY } from './reconciliationFinding.constants';

const reconciliationFindingSchema = new Schema<
  TReconciliationFinding,
  ReconciliationFindingModel
>(
  {
    runAt: { type: Date, required: true },
    checkName: { type: String, required: true },
    severity: {
      type: String,
      enum: Object.values(RECONCILIATION_SEVERITY),
      required: true,
    },
    entityType: { type: String },
    entityId: { type: Schema.Types.ObjectId, default: null },
    detail: { type: Schema.Types.Mixed, required: true },
    alertedAt: { type: Date, default: null },
    resolvedAt: { type: Date, default: null },
    resolvedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { strict: true },
);

reconciliationFindingSchema.index({ runAt: -1, severity: 1 });
reconciliationFindingSchema.index({ resolvedAt: 1, severity: 1 });

export const ReconciliationFinding = model<
  TReconciliationFinding,
  ReconciliationFindingModel
>('ReconciliationFinding', reconciliationFindingSchema);
