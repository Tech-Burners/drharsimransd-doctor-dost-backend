export const VERIFICATION_STATUS = {
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
} as const;
export const VERIFICATION_REJECTION_REASON = {
  ILLEGIBLE_DOCUMENT: 'illegible_document',
  DETAILS_MISMATCH: 'details_mismatch',
  INVALID_REGISTRATION: 'invalid_registration',
  EXPIRED_REGISTRATION: 'expired_registration',
  OTHER: 'other',
} as const;
