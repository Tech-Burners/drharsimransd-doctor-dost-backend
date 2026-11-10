export const CALL_STATUS = {
  RINGING: 'ringing',
  REJECTED: 'rejected',
  MISSED: 'missed',
  ACTIVE: 'active',
  COMPLETED: 'completed',
  ENDED_LOW_BALANCE: 'ended_low_balance',
  FAILED: 'failed',
} as const;

export const CALL_END_REASON = {
  PATIENT_ENDED: 'patient_ended',
  DOCTOR_ENDED: 'doctor_ended',
  LOW_BALANCE: 'low_balance',
  DOCTOR_REJECTED: 'doctor_rejected',
  PATIENT_MISSED: 'patient_missed',
  DOCTOR_MISSED: 'doctor_missed',
  SYSTEM_TIMEOUT: 'system_timeout',
  SYSTEM_ERROR: 'system_error',
  // The Agora end event never arrived and the overdue-call sweep closed the call.
  // Deferral to a human via ReconciliationFinding, NOT a billing decision.
  NO_END_EVENT: 'no_end_event',
} as const;

export const CALL_TIME_SLOT = {
  DAY: 'day',
  NIGHT: 'night',
} as const;

export const PRESCRIPTION_STATUS = {
  PENDING: 'pending',
  SUBMITTED: 'submitted',
  EXPIRED: 'expired',
  NOT_REQUIRED: 'not_required',
} as const;
