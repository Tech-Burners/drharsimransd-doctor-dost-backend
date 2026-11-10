import { Model, Types } from 'mongoose';

export type TReconciliationSeverity = 'info' | 'warning' | 'critical';

export interface TReconciliationFinding {
  runAt: Date;
  checkName: string;
  severity: TReconciliationSeverity;
  entityType?: string;
  entityId: Types.ObjectId | null;
  detail: unknown;
  alertedAt: Date | null;
  resolvedAt: Date | null;
  resolvedBy: Types.ObjectId | null;
}

export type ReconciliationFindingModel = Model<TReconciliationFinding>;
